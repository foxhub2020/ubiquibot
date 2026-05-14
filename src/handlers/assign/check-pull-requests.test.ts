import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import axios from "axios";
import { Context } from "../../types/context";
import {
  appendIssueReferenceToBody,
  associatePullRequestWithAssignedIssue,
  buildAmbiguousAssignedIssuesComment,
} from "./check-pull-requests";

jest.mock("axios");

const mockedAxios = axios as jest.Mocked<typeof axios>;

function createContext(assignedIssues: unknown[] = []) {
  const updatePullRequest = jest.fn();
  const createComment = jest.fn();
  const paginate = jest.fn(async () => assignedIssues);

  return {
    context: {
      logger: {
        debug: jest.fn(),
        fatal: jest.fn(),
      },
      payload: {
        repository: {
          owner: {
            login: "ubiquity",
          },
          name: "ubiquibot",
        },
      },
      octokit: {
        paginate,
        issues: {
          createComment,
        },
        rest: {
          issues: {
            listForRepo: jest.fn(),
          },
          pulls: {
            update: updatePullRequest,
          },
        },
      },
    } as unknown as Context,
    createComment,
    paginate,
    updatePullRequest,
  };
}

function mockLinkedIssuesHtml(issueNumber?: number) {
  if (!issueNumber) {
    return `<div data-target="create-branch.developmentForm"></div>`;
  }

  return `<div data-target="create-branch.developmentForm"><div class="my-1"><a href="/ubiquity/ubiquibot/issues/${issueNumber}">#${issueNumber}</a></div></div>`;
}

describe("appendIssueReferenceToBody", () => {
  test("appends a GitHub closing keyword to an existing body", () => {
    expect(appendIssueReferenceToBody("Implementation notes", 231)).toBe("Implementation notes\n\nResolves #231");
  });

  test("does not duplicate an existing closing keyword", () => {
    expect(appendIssueReferenceToBody("Resolves #231", 231)).toBe("Resolves #231");
  });
});

describe("buildAmbiguousAssignedIssuesComment", () => {
  test("lists assigned issues and asks the opener to link manually", () => {
    const comment = buildAmbiguousAssignedIssuesComment("alice", [
      { number: 1, html_url: "https://github.com/ubiquity/ubiquibot/issues/1" },
      { number: 2, html_url: "https://github.com/ubiquity/ubiquibot/issues/2" },
    ]);

    expect(comment).toContain("@alice");
    expect(comment).toContain("[#1](https://github.com/ubiquity/ubiquibot/issues/1)");
    expect(comment).toContain("[#2](https://github.com/ubiquity/ubiquibot/issues/2)");
    expect(comment).toContain("Resolves #123");
  });
});

describe("associatePullRequestWithAssignedIssue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.get.mockResolvedValue({ data: mockLinkedIssuesHtml() });
  });

  test("updates the pull request body when the opener has one assigned issue", async () => {
    const { context, createComment, updatePullRequest } = createContext([
      { number: 231, html_url: "https://github.com/ubiquity/ubiquibot/issues/231" },
      { number: 20, pull_request: {} },
    ]);

    await associatePullRequestWithAssignedIssue(context, {
      number: 10,
      body: "Implements the association flow.",
      user: { login: "alice" },
    });

    expect(updatePullRequest).toHaveBeenCalledWith({
      owner: "ubiquity",
      repo: "ubiquibot",
      pull_number: 10,
      body: "Implements the association flow.\n\nResolves #231",
    });
    expect(createComment).not.toHaveBeenCalled();
  });

  test("comments instead of updating when multiple assigned issues are possible", async () => {
    const { context, createComment, updatePullRequest } = createContext([
      { number: 231, html_url: "https://github.com/ubiquity/ubiquibot/issues/231" },
      { number: 791, html_url: "https://github.com/ubiquity/ubiquibot/issues/791" },
    ]);

    await associatePullRequestWithAssignedIssue(context, {
      number: 10,
      body: "Implementation notes.",
      user: { login: "alice" },
    });

    expect(updatePullRequest).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith({
      owner: "ubiquity",
      repo: "ubiquibot",
      issue_number: 10,
      body: expect.stringContaining("multiple open issues"),
    });
  });

  test("skips updates when GitHub already links the pull request", async () => {
    const { context, paginate, updatePullRequest } = createContext([{ number: 231 }]);
    mockedAxios.get.mockResolvedValue({ data: mockLinkedIssuesHtml(231) });

    await associatePullRequestWithAssignedIssue(context, {
      number: 10,
      body: "Resolves #231",
      user: { login: "alice" },
    });

    expect(paginate).not.toHaveBeenCalled();
    expect(updatePullRequest).not.toHaveBeenCalled();
  });
});
