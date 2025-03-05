# List Unique Projects GitHub Action

This GitHub Action lists unique projects and counts the number of issues associated with one or more projects. It generates a CSV file with the collected data.

## Inputs

- `github_token` (optional): GitHub token
- `github_app_id` (optional): GitHub App ID
- `github_private_key` (optional): GitHub Private Key
- `github_installation_id` (optional): GitHub Installation ID
- `api_url` (optional): GitHub API URL
- `repos_file` (required): Path to the file containing the list of repositories (one repo per line)
- `org_name` (required): Organization name
- `output_file` (optional): Output CSV file name (default: `output.csv`)

## Outputs

This action generates a CSV file with the following headers:

- `org_name`: Name of the organization
- `repo_name`: Name of the repository
- `issues_linked_to_projects`: Number of issues linked to at least one project
- `unique_projects_linked_by_issues`: Number of unique projects linked across all issues
- `projects_linked_to_repo`: Number of projects linked to the repository

## Token Permissions

### GitHub App

The GitHub App must have the following permissions:

- `Contents`: Read
- `Issues`: Read
- `Projects`: Read

### Personal Access Token

The personal access token must have the following scopes:

- `repo`
- `read:org`

## Example Usage

```yaml
name: List Unique Projects
on: [push]

jobs:
  list-projects:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v2

      - name: List Unique Projects
        uses: ./.github/actions/list-unique-projects
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          repos_file: path/to/repos.txt
          org_name: my-org
          output_file: output.csv
```