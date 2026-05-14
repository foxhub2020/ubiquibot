import axios from "axios";
import { HTMLElement, parse } from "node-html-parser";
import { getAllPullRequests, addAssignees, addCommentToIssue } from "../../helpers/issue";
import { Context } from "../../types/context";
import { GitHubPayload } from "../../types/payload";

interface PullRequestSummary {
  number: number;
  body?: string | null;
  user?: {
    login: string;
  } | null;
}

interface AssignedIssue {
  number: number;
  html_url?: string;
  pull_request?: unknown;
}

type PullRequestPayload = GitHubPayload & {
  pull_request?: PullRequestSummary;
};

const CLOSING_KEYWORD_REGEX = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+\b/i;

// Check for pull requests linked to their respective issues but not assigned to them
export async function checkPullRequests(context: Context): Promise<null> {
  const { logger, payload } = context;
  const pullRequest = (payload as PullRequestPayload).pull_request;

  if (pullRequest) {
    await associatePullRequestWithAssignedIssue(context, pullRequest);
  }

  const pulls = await getAllPullRequests(context);

  if (pulls.length === 0) {
    logger.debug(`No pull requests found at this time`);
    return null;
  }

  // Loop through the pull requests and assign them to their respective issues if needed
  for (const pull of pulls) {
    const linkedIssue = await getLinkedIssues({
      owner: payload.repository.owner.login,
      repository: payload.repository.name,
      pull: pull.number,
    });

    // if pullRequestLinked is empty, continue
    if (linkedIssue == null || !pull.user || !linkedIssue) {
      continue;
    }

    const connectedPull = await getPullByNumber(context, pull.number);

    // Newly created PULL (draft or direct) pull does have same `created_at` and `updated_at`.
    if (connectedPull?.created_at !== connectedPull?.updated_at) {
      logger.debug("It's an updated Pull Request, reverting");
      continue;
    }

    const linkedIssueNumber = linkedIssue.substring(linkedIssue.lastIndexOf("/") + 1);

    // Check if the pull request opener is assigned to the issue
    const opener = pull.user.login;

    const issue = await getIssueByNumber(context, +linkedIssueNumber);
    if (!issue?.assignees) continue;

    // if issue is already assigned, continue
    if (issue.assignees.length > 0) {
      logger.debug(`Issue already assigned, ignoring...`);
      continue;
    }

    const assignedUsernames = issue.assignees.map((assignee) => assignee.login);
    if (!assignedUsernames.includes(opener)) {
      await addAssignees(context, +linkedIssueNumber, [opener]);
      logger.debug("Assigned pull request opener to issue", {
        pullRequest: pull.number,
        issue: linkedIssueNumber,
        opener,
      });
    }
  }
  logger.debug(`Checking pull requests done!`);
  return null;
}

export async function getLinkedIssues({ owner, repository, pull }: GetLinkedParams) {
  const { data } = await axios.get(`https://github.com/${owner}/${repository}/pull/${pull}`);
  const dom = parse(data);
  const devForm = dom.querySelector("[data-target='create-branch.developmentForm']") as HTMLElement;
  if (!devForm) {
    return null;
  }

  const linkedIssues = devForm.querySelectorAll(".my-1");

  if (linkedIssues.length === 0) {
    return null;
  }

  const issueUrl = linkedIssues[0].querySelector("a")?.attrs?.href || null;
  return issueUrl;
}

export async function associatePullRequestWithAssignedIssue(context: Context, pull: PullRequestSummary) {
  const { logger, payload } = context;
  const owner = payload.repository.owner.login;
  const repository = payload.repository.name;
  const opener = pull.user?.login;

  if (!opener) {
    logger.debug("Skipping pull request association because the opener is missing", { pullRequest: pull.number });
    return;
  }

  const linkedIssue = await getLinkedIssues({
    owner,
    repository,
    pull: pull.number,
  });

  if (linkedIssue) {
    logger.debug("Pull request already has a linked issue", { pullRequest: pull.number, linkedIssue });
    return;
  }

  const assignedIssues = await getOpenIssuesAssignedToUser(context, opener);

  if (assignedIssues.length === 0) {
    logger.debug("No assigned issue found for pull request opener", { pullRequest: pull.number, opener });
    return;
  }

  if (assignedIssues.length > 1) {
    await addCommentToIssue(context, buildAmbiguousAssignedIssuesComment(opener, assignedIssues), pull.number);
    logger.debug("Skipped automatic pull request association because multiple assigned issues were found", {
      pullRequest: pull.number,
      opener,
      assignedIssues: assignedIssues.map((issue) => issue.number),
    });
    return;
  }

  const [issue] = assignedIssues;
  const updatedBody = appendIssueReferenceToBody(pull.body, issue.number);

  if (updatedBody === (pull.body ?? "")) {
    logger.debug("Pull request body already contains a closing keyword", {
      pullRequest: pull.number,
      issue: issue.number,
    });
    return;
  }

  await context.octokit.rest.pulls.update({
    owner,
    repo: repository,
    pull_number: pull.number,
    body: updatedBody,
  });

  logger.debug("Automatically associated pull request with assigned issue", {
    pullRequest: pull.number,
    issue: issue.number,
    opener,
  });
}

export async function getOpenIssuesAssignedToUser(context: Context, username: string): Promise<AssignedIssue[]> {
  const payload = context.payload;
  const issues = await context.octokit.paginate(context.octokit.rest.issues.listForRepo, {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    state: "open",
    assignee: username,
    per_page: 100,
  });

  return issues.filter((issue) => !("pull_request" in issue)) as AssignedIssue[];
}

export function appendIssueReferenceToBody(body: string | null | undefined, issueNumber: number) {
  const normalizedBody = body?.trimEnd() ?? "";

  if (CLOSING_KEYWORD_REGEX.test(normalizedBody)) {
    return normalizedBody;
  }

  const reference = `Resolves #${issueNumber}`;
  return normalizedBody ? `${normalizedBody}\n\n${reference}` : reference;
}

export function buildAmbiguousAssignedIssuesComment(username: string, issues: AssignedIssue[]) {
  const issueLinks = issues
    .map((issue) => (issue.html_url ? `[#${issue.number}](${issue.html_url})` : `#${issue.number}`))
    .join(", ");

  return `@${username} I could not automatically link this pull request because you are assigned to multiple open issues: ${issueLinks}.\n\nPlease add a closing keyword such as \`Resolves #123\` to the pull request body so GitHub can associate it with the correct issue.`;
}

export async function getPullByNumber(context: Context, pull: number) {
  const payload = context.payload;

  try {
    const response = await context.octokit.rest.pulls.get({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pull_number: pull,
    });
    return response.data;
  } catch (err: unknown) {
    context.logger.fatal("Fetching pull request failed!", err);
    return;
  }
}
// Get issues by issue number
export async function getIssueByNumber(context: Context, issueNumber: number) {
  const payload = context.payload;
  try {
    const { data: issue } = await context.octokit.rest.issues.get({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: issueNumber,
    });
    return issue;
  } catch (e: unknown) {
    context.logger.fatal("Fetching issue failed!", e);
    return;
  }
}
export interface GetLinkedParams {
  owner: string;
  repository: string;
  issue?: number;
  pull?: number;
}
