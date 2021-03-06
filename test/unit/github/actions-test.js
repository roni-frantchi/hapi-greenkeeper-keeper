import {assert} from 'chai';
import sinon from 'sinon';
import any from '@travi/any';
import * as octokitFactory from '../../../src/github/octokit-factory-wrapper';
import actionsFactory from '../../../src/github/actions';
import {FailedStatusFoundError, InvalidStatusFoundError, MergeFailureError} from '../../../src/errors';

suite('github actions', () => {
  let
    sandbox,
    actions,
    octokitAuthenticate,
    octokitIssueSearch,
    octokitGetPr,
    octokitMergePr,
    octokitCombinedStatus,
    octokitDeleteRef,
    octokitCreateIssueComment;
  const token = any.simpleObject();
  const githubCredentials = {...any.simpleObject(), token};
  const sha = any.string();
  const ref = any.string();
  const repoOwner = any.word();
  const repoName = any.word();
  const repo = {name: repoName, owner: {login: repoOwner}};
  const prNumber = any.string();
  const response = {data: any.simpleObject()};
  const log = () => undefined;

  setup(() => {
    sandbox = sinon.sandbox.create();

    octokitAuthenticate = sinon.spy();
    octokitIssueSearch = sinon.stub();
    octokitGetPr = sinon.stub();
    octokitCombinedStatus = sinon.stub();
    octokitMergePr = sinon.stub();
    octokitDeleteRef = sinon.stub();
    octokitCreateIssueComment = sinon.stub();

    sandbox.stub(octokitFactory, 'default');

    octokitFactory.default.returns({
      authenticate: octokitAuthenticate,
      search: {issues: octokitIssueSearch},
      pullRequests: {
        get: octokitGetPr,
        merge: octokitMergePr
      },
      issues: {createComment: octokitCreateIssueComment},
      repos: {getCombinedStatusForRef: octokitCombinedStatus},
      gitdata: {deleteReference: octokitDeleteRef}
    });
    actions = actionsFactory(githubCredentials);
  });

  teardown(() => sandbox.restore());

  const assertAuthenticatedForOctokit = () => assert.calledWith(octokitAuthenticate, {type: 'token', token});

  suite('ensure PR can be merged', () => {
    test('that the passing status is acceptable', () => {
      octokitCombinedStatus.withArgs({owner: repoOwner, repo: repoName, ref: sha}).resolves({data: {state: 'success'}});

      return assert.becomes(
        actions.ensureAcceptability({repo, sha}, () => undefined),
        'All commit statuses passed'
      ).then(assertAuthenticatedForOctokit);
    });

    test('that the failing status results in rejection', () => {
      octokitCombinedStatus.withArgs({owner: repoOwner, repo: repoName, ref: sha}).resolves({data: {state: 'failure'}});

      return assert.isRejected(
        actions.ensureAcceptability({repo, sha}, () => undefined),
        FailedStatusFoundError,
        /A failed status was found for this PR\./
      ).then(assertAuthenticatedForOctokit);
    });

    test('that the pending status results in rejection', () => {
      octokitCombinedStatus.withArgs({owner: repoOwner, repo: repoName, ref: sha}).resolves({data: {state: 'pending'}});

      return assert.isRejected(
        actions.ensureAcceptability({repo, sha}, log, any.integer()),
        'pending'
      ).then(assertAuthenticatedForOctokit);
    });

    test('that an invalid status results in rejection', () => {
      octokitCombinedStatus
        .withArgs({owner: repoOwner, repo: repoName, ref: sha})
        .resolves({data: {state: any.string()}});

      return assert.isRejected(
        actions.ensureAcceptability({repo, sha}, log),
        InvalidStatusFoundError,
        /An invalid status was found for this PR\./
      ).then(assertAuthenticatedForOctokit);
    });
  });

  suite('accept PR', () => {
    test('that the referenced PR gets accepted', () => {
      const acceptAction = any.string();
      octokitMergePr.withArgs({
        owner: repoOwner,
        repo: repoName,
        number: prNumber,
        sha,
        commit_title: `greenkeeper-keeper(pr: ${prNumber}): :white_check_mark:`,
        commit_message: `greenkeeper-keeper(pr: ${prNumber}): :white_check_mark:`,
        merge_method: acceptAction
      }).resolves(response);

      return assert.becomes(actions.acceptPR(repo, sha, prNumber, acceptAction, log), response.data)
        .then(assertAuthenticatedForOctokit);
    });

    test('that a merge failure is reported appropriately', () => {
      octokitMergePr.rejects(new Error('error from PUT request in test'));

      return assert.isRejected(
        actions.acceptPR(repo),
        MergeFailureError,
        /An attempt to merge this PR failed. Error: error from PUT request in test$/
      ).then(assertAuthenticatedForOctokit);
    });
  });

  suite('comments', () => {
    test('that an error comment is posted', () => {
      const message = any.string();
      const error = new Error(message);
      octokitCreateIssueComment.withArgs({
        owner: repoOwner,
        repo: repoName,
        number: prNumber,
        body: `:x: greenkeeper-keeper failed to merge the pull-request \n> ${message}`
      }).resolves(response);

      return assert.becomes(actions.postErrorComment(repo, prNumber, error), response)
        .then(assertAuthenticatedForOctokit);
    });
  });

  suite('PRs for a commit', () => {
    test('that PRs with HEAD matching a commit are fetched', () => {
      const pullRequests = any.listOf(any.simpleObject);
      octokitIssueSearch.withArgs({q: `${ref}+type:pr`}).returns({data: {items: pullRequests}});

      return assert.becomes(actions.getPullRequestsForCommit({ref}), pullRequests).then(assertAuthenticatedForOctokit);
    });
  });

  test('that the PR gets requested by issue number', () => {
    const pullRequest = any.simpleObject();
    octokitGetPr.withArgs({owner: repoOwner, repo: repoName, number: prNumber}).resolves({data: pullRequest});

    return assert.becomes(actions.getPullRequest(repo, prNumber), pullRequest);
  });
});
