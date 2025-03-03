import * as core from "@actions/core";
import { Octokit } from "@octokit/core";
import { paginateGraphQL } from "@octokit/plugin-paginate-graphql";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { createAppAuth } from "@octokit/auth-app";
import fetch from "node-fetch";
import { createRequire } from "module";
import { json } from "stream/consumers";

const MyOctokit = Octokit.plugin(paginateGraphQL, retry, throttling);

core.debug("Debug mode is enabled");
const auth = core.getInput("github_app_id")
    ? {
        appId: core.getInput("github_app_id"),
        privateKey: core.getInput("github_private_key"),
        installationId: core.getInput("github_installation_id"),
    }
    : core.getInput("github_token");
core.debug(`auth: ${JSON.stringify(auth)}`);

const octokit = new MyOctokit({
  authStrategy: core.getInput("github_app_id") ? createAppAuth : undefined,
  auth: auth,

  request: { fetch },
  log: core.isDebug() ? console : null,
  throttle: {
    onRateLimit: (retryAfter, options, octokit, retryCount) => {
      octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`);

      if (retryCount < 1) {
        // only retries once
        octokit.log.info(`Retrying after ${retryAfter} seconds!`);
        return true;
      }
    },
    onSecondaryRateLimit: (retryAfter, options, octokit) => {
      // does not retry, only logs a warning
      octokit.log.warn(`SecondaryRateLimit detected for request ${options.method} ${options.url}`);
    },
    onAbuseLimit: (retryAfter, options) => {
      console.warn(`Abuse detected for request ${options.method} ${options.url}`);
      return true;
    },
  },
});

const query = `
  query($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, after: $cursor) {
        pageInfo {
          endCursor
          hasNextPage
        }
        nodes {
          projectsV2(first: 100) {
            nodes {
              number
              title
            }
          }
        }
      }
    }
  }
`;

const projectsQuery = `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      projectsV2(first: 100) {
        nodes {
          number
          title
        }
      }
    }
  }
`;

function formatProjectDetails({ number, title }) {
  return `"${title}" (#${number})`;
}

async function getLinkedProjects(owner, repo) {
  const linkedProjectsResponse = await octokit.graphql(projectsQuery, { owner, repo });
  core.debug(`Linked Projects GraphQL Response: ${JSON.stringify(linkedProjectsResponse, null, 2)}`);

  const linkedProjects = linkedProjectsResponse.repository.projectsV2.nodes;
  const linkedProjectDetails = linkedProjects.map(formatProjectDetails).join(', ');
  core.info(`Projects linked to repo: ${linkedProjects.length} [${linkedProjectDetails}]`);
}

async function listUniqueProjects(owner, repo) {
  const uniqueProjects = new Map();
  let issueCount = 0;
  let issuesWithProjectCount = 0;

  const response = await octokit.graphql.paginate(query, { owner, repo });
  core.debug(`Issues GraphQL Response: ${JSON.stringify(response, null, 2)}`);

  issueCount = response.repository.issues.nodes.length;

  // Loop through all issues
  for (const node of response.repository.issues.nodes) {

    // Count the number of issues with 1+ project linked to it
    const projects = node.projectsV2.nodes;
    if (projects.length > 0) {
      issuesWithProjectCount += 1;
    }

    // Collect all projects associated with issues
    projects.forEach((project) => {
      // Record project if not seen before
      if (!uniqueProjects.has(project.number)) {
        uniqueProjects.set(project.number, { title: project.title, count: 0 });
      }

      // Record number of issues associated with each project
      uniqueProjects.get(project.number).count += 1;
    });
  }

  // Collect project info as an array of ["title" (#number)]
  const projectDetails = Array
    .from(uniqueProjects.entries())
    .map(([number, project]) => formatProjectDetails({ number, title: project.title }))
    .join(', ');

  core.info(`Total issues: ${issueCount}`);
  core.info(`Issues with at least one project: ${issuesWithProjectCount}`);
  
  core.info(`Projects linked to issues: ${uniqueProjects.size} [${projectDetails}]`);
}

async function getRateLimit() {
  const rateLimitQuery = `
    query {
      rateLimit {
        remaining
      }
    }
  `;
  const response = await octokit.graphql(rateLimitQuery);
  return response.rateLimit.remaining;
}

/**
 * Output format:
    GraphQL calls remaining: xxxx
    Total issues: xxxx
    Issues with at least one project: xxxx
    Projects linked to issues: xxxx ["title" (#x), "title" (#x),...]
    ------------------
    GraphQL calls remaining: xxxx
    Projects linked to repo: xxxx ["title" (#x), "title" (#x),...]
    ------------------
    GraphQL calls remaining: xxxx
 */
async function main() {
  const org = core.getInput("org")
  const repo = core.getInput("repo")
  core.debug(`Reading project details for: "${org}/${repo}"`);

  core.info(`GraphQL calls remaining: ${await getRateLimit()}`);
  await listUniqueProjects(org, repo);
  core.info("------------------");

  core.info(`GraphQL calls remaining: ${await getRateLimit()}`);
  await getLinkedProjects(org, repo);
  core.info("------------------");
  
  core.info(`GraphQL calls remaining: ${await getRateLimit()}`);
}

main();
