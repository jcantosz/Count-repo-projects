import * as core from "@actions/core";
import { Octokit } from "@octokit/core";
import { paginateGraphQL } from "@octokit/plugin-paginate-graphql";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { createAppAuth } from "@octokit/auth-app";
import fetch from "node-fetch";
import fs from "fs";
import readline from "readline";
import { createReadStream } from "fs";

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
  baseUrl: core.getInput("api_url") || "https://api.github.com",
  request: { fetch },
  log: core.isDebug() ? console : null,
  throttle: {
    onRateLimit: (retryAfter, options, octokit, retryCount) => {
      octokit.log.warn(
        `Request quota exhausted for request ${options.method} ${options.url}`,
      );

      if (retryCount < 1) {
        // only retries once
        octokit.log.info(`Retrying after ${retryAfter} seconds!`);
        return true;
      }
    },
    onSecondaryRateLimit: (retryAfter, options, octokit) => {
      // does not retry, only logs a warning
      octokit.log.warn(
        `SecondaryRateLimit detected for request ${options.method} ${options.url}`,
      );
    },
    onAbuseLimit: (retryAfter, options) => {
      console.warn(
        `Abuse detected for request ${options.method} ${options.url}`,
      );
      return true;
    },
  },
});

function formatProjectDetails({ number, title }) {
  return `"${title}" (#${number})`;
}

async function listUniqueProjects(owner, repo) {
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
        },
        projectsV2(first: 100) {
          totalCount
        }
      }
    }
  `;

  const uniqueProjects = new Map();
  let issueCount = 0;
  let issuesWithProjectCount = 0;
  let linkedProjectsCount = 0;

  try {
    const response = await octokit.graphql.paginate(query, { owner, repo });
    core.debug(`Issues GraphQL Response: ${JSON.stringify(response, null, 2)}`);

    issueCount = response.repository.issues.nodes.length;
    linkedProjectsCount = response.repository.projectsV2.totalCount;

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
          uniqueProjects.set(project.number, {
            title: project.title,
            count: 0,
          });
        }

        // Record number of issues associated with each project
        uniqueProjects.get(project.number).count += 1;
      });
    }

    // Collect project info as an array of ["title" (#number)]
    const projectDetails = Array.from(uniqueProjects.entries())
      .map(([number, project]) =>
        formatProjectDetails({ number, title: project.title }),
      )
      .join(", ");

    core.info(`Total issues: ${issueCount}`);
    core.info(`Issues with at least one project: ${issuesWithProjectCount}`);
    core.info(
      `Projects linked to issues: ${uniqueProjects.size} [${projectDetails}]`,
    );
    core.info(`Total linked projects: ${linkedProjectsCount}`);
  } catch (error) {
    core.error(
      `Error fetching unique projects for ${owner}/${repo}: ${error.message}`,
    );
    throw error;
  }

  return { uniqueProjects, issuesWithProjectCount, linkedProjectsCount };
}

async function getRateLimit() {
  const rateLimitQuery = `
    query {
      rateLimit {
        remaining
      }
    }
  `;
  try {
    const response = await octokit.graphql(rateLimitQuery);
    return response.rateLimit.remaining;
  } catch (error) {
    core.error(`Error fetching rate limit: ${error.message}`);
    throw error;
  }
}

async function readReposFromFile(filePath) {
  core.info(`Reading repos from file: ${filePath}`);
  if (!fs.existsSync(filePath)) {
    core.setFailed(`File not found: ${filePath}`);
    return [];
  }
  if (!fs.statSync(filePath).isFile()) {
    core.setFailed(`Path is not a file: ${filePath}`);
    return [];
  }
  const repos = [];
  const fileStream = createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    repos.push(line.trim());
  }

  return repos;
}

/**
  * outputs csv file of the form:
  * org_name,repo_name,issues_linked_to_projects,unique_projects_linked_by_issues,projects_linked_to_repo
  * org_name: name of the org
  * repo_name: name of the repo
  * issues_linked_to_projects: number of issues linked to at least one project
  * unique_projects_linked_by_issues: how mny unique projects are linked across all of the issues issues
  * projects_linked_to_repo: number of projects linked to the repo
  * 
  * 
  * stdout:
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
  try {
    const remainingCalls = await getRateLimit();
    core.info(`GraphQL calls remaining: ${remainingCalls}`);

    const reposFilePath = core.getInput("repos_file");
    const repos = await readReposFromFile(reposFilePath);
    const orgName = core.getInput("org_name");
    const outputFileName = core.getInput("output_file") || "output.csv";

    const csvHeaders =
      "org_name,repo_name,issues_linked_to_projects,unique_projects_linked_by_issues,projects_linked_to_repo\n";
    let csvData = "";

    for (const repo of repos) {
      try {
        const { uniqueProjects, issuesWithProjectCount, linkedProjectsCount } =
          await listUniqueProjects(orgName, repo);
        core.info(`Processing repo "${orgName}/${repo}"`);
        const projectDetails = Array.from(uniqueProjects.entries())
          .map(([number, project]) =>
            formatProjectDetails({ number, title: project.title }),
          )
          .join(", ");
        core.info(`Issue projects: ${uniqueProjects.size} [${projectDetails}]`);

        csvData += `${orgName},${repo},${issuesWithProjectCount},${uniqueProjects.size},${linkedProjectsCount}\n`;
      } catch (error) {
        core.error(
          `Error processing repo ${orgName}/${repo}: ${error.message}`,
        );
      }
    }

    fs.writeFileSync(outputFileName, csvHeaders + csvData);
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

main();
