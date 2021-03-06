import {assert} from 'chai';
import sinon from 'sinon';
import {ACCEPTED, NO_CONTENT, BAD_REQUEST, UNSUPPORTED_MEDIA_TYPE} from 'http-status-codes';
import any from '@travi/any';
import boom from 'boom';
import * as actionsFactory from '../../src/github/actions';
import * as greenkeeper from '../../src/greenkeeper';
import * as process from '../../src/process';
import handler from '../../src/handler';

suite('handler', () => {
  let sandbox, response, code;
  const greenkeeperSender = any.url();
  const githubCredentials = {token: any.string()};
  const settings = {...any.simpleObject(), github: githubCredentials};
  const log = sinon.spy();

  setup(() => {
    response = sinon.stub();
    code = sinon.spy();

    sandbox = sinon.sandbox.create();

    response.withArgs('skipping').returns({code});

    sandbox.stub(boom, 'internal');
    sandbox.stub(greenkeeper, 'default')
      .returns(false)
      .withArgs(greenkeeperSender).returns(true);
    sandbox.stub(process, 'default').resolves();
  });

  teardown(() => {
    sandbox.restore();
    log.resetHistory();
  });

  suite('`pull_request` event', () => {
    test('that response is bad-request when the webhook action is a `pull_request`', () => {
      const request = {
        payload: {
          action: any.word(),
          sender: {
            html_url: greenkeeperSender
          }
        },
        headers: {'x-github-event': 'pull_request'},
        log
      };

      return handler(request, {response}, settings).then(() => {
        assert.calledWith(code, BAD_REQUEST);
        assert.calledWith(log, ['PR', 'skipping']);
      });
    });

    test('that response is bad-request when pr not opened by greenkeeper', () => {
      const request = {
        payload: {
          action: 'opened',
          sender: {
            html_url: any.url()
          }
        },
        headers: {'x-github-event': 'pull_request'},
        log
      };

      return handler(request, {response}, settings).then(() => {
        assert.calledWith(code, BAD_REQUEST);
        assert.calledWith(log, ['PR', 'skipping']);
      });
    });
  });

  suite('`status` event', () => {
    let getPullRequestsForCommit, getPullRequest;
    const error = new Error(any.simpleObject());
    const wrappedError = any.simpleObject();

    setup(() => {
      getPullRequestsForCommit = sinon.stub();
      getPullRequest = sinon.stub();

      sandbox.stub(actionsFactory, 'default')
        .withArgs(githubCredentials)
        .returns({getPullRequestsForCommit, getPullRequest});
    });

    test('that the webhook is accepted and processed for a successful status and a matching greenkeeper PR', () => {
      const repository = any.simpleObject();
      const branch = any.string();
      const prNumber = any.integer();
      const sha = any.string();
      const partialPullRequest = {user: {html_url: greenkeeperSender}, number: prNumber};
      const fullPullRequest = any.simpleObject();
      const request = {
        payload: {
          state: 'success',
          sha,
          repository,
          branches: [{name: branch}]
        },
        headers: {'x-github-event': 'status'},
        log: () => undefined
      };
      response.withArgs('ok').returns({code});
      getPullRequestsForCommit.withArgs({ref: sha}).resolves([partialPullRequest]);
      getPullRequest.withArgs(repository, prNumber).resolves(fullPullRequest);

      return handler(request, {response}, settings).then(() => {
        assert.calledWith(code, ACCEPTED);
        assert.calledWith(process.default, request, fullPullRequest, settings);
      });
    });

    test('that the response is bad-request when the state is not `success`', () => {
      const request = {
        payload: {state: any.string()},
        headers: {'x-github-event': 'status'},
        log
      };

      return handler(request, {response}, settings).then(() => {
        assert.calledWith(code, BAD_REQUEST);
        assert.calledWith(log, ['PR', 'skipping']);
      });
    });

    test('that the response is bad-request when commit is on multiple branches', () => {
      const request = {
        payload: {state: 'success', branches: [{}, {}]},
        headers: {'x-github-event': 'status'},
        log
      };

      return handler(request, {response}, settings).then(() => {
        assert.calledWith(code, BAD_REQUEST);
        assert.calledWith(log, ['PR', 'skipping']);
      });
    });

    test('that the response is bad-request when commit is on master', () => {
      const request = {
        payload: {state: 'success', branches: [{name: 'master'}]},
        headers: {'x-github-event': 'status'},
        log
      };

      return handler(request, {response}, settings).then(() => {
        assert.calledWith(code, BAD_REQUEST);
        assert.calledWith(log, ['PR', 'skipping']);
      });
    });

    test('that the response is bad-request if there are no PRs for the commit', () => {
      const request = {
        payload: {state: 'success', branches: [{name: any.string()}]},
        headers: {'x-github-event': 'status'},
        log: () => undefined
      };
      getPullRequestsForCommit.resolves([]);
      response.withArgs('no PRs for this commit').returns({code});

      return handler(request, {response}, settings).then(() => assert.calledWith(code, BAD_REQUEST));
    });

    test('that a server-error is returned if the list of PRs for the commit is greater than one', () => {
      const request = {
        payload: {state: 'success', branches: [{name: any.string()}]},
        headers: {'x-github-event': 'status'},
        log: () => undefined
      };
      getPullRequestsForCommit.resolves([{}, {}]);
      boom.internal.withArgs('too many PRs exist for this commit').returns(error);

      return handler(request, {response}, settings).then(() => assert.calledWith(response, error));
    });

    test('that the response is bad-request if the PR is not from greenkeeper', () => {
      const request = {
        payload: {state: 'success', branches: [{name: any.string()}]},
        headers: {'x-github-event': 'status'},
        log: () => undefined
      };
      getPullRequestsForCommit.resolves([{user: {html_url: any.url()}}]);
      response.withArgs('PR is not from greenkeeper').returns({code});

      return handler(request, {response}, settings).then(() => assert.calledWith(code, BAD_REQUEST));
    });

    test('that a server-error is reported if the fetching of related PRs fails', () => {
      const request = {
        payload: {
          state: 'success',
          repository: any.string(),
          branches: [{name: any.string()}]
        },
        headers: {'x-github-event': 'status'},
        log: () => undefined
      };
      getPullRequestsForCommit.rejects(error);
      boom.internal.withArgs('failed to fetch PRs', error).returns(wrappedError);

      return handler(request, {response}, settings).then(err => assert.equal(err, wrappedError));
    });
  });

  suite('`ping` event', () => {
    test('that a 204 response is provided for a ping request', () => {
      const request = {
        payload: {
          hook: {
            config: {
              content_type: 'json'
            }
          }
        },
        headers: {'x-github-event': 'ping'},
        log: () => undefined
      };
      response.withArgs('successfully configured the webhook for greenkeeper-keeper').returns({code});

      return handler(request, {response}, settings).then(() => assert.calledWith(code, NO_CONTENT));
    });

    test('that a 415 response is sent when the ping shows that the hook is not configured to send json', () => {
      const request = {
        payload: {
          hook: {
            config: {
              content_type: 'form'
            }
          }
        },
        headers: {'x-github-event': 'ping'},
        log: () => undefined
      };
      response.withArgs('please update your webhook configuration to send application/json').returns({code});

      return handler(request, {response}, settings).then(() => assert.calledWith(code, UNSUPPORTED_MEDIA_TYPE));
    });
  });

  suite('other statuses', () => {
    test('that response is bad-request when the webhook event is not `pull_request` or `status', () => {
      const request = {
        payload: {},
        headers: {'x-github-event': any.word()},
        log
      };

      return handler(request, {response}, settings).then(() => {
        assert.calledWith(code, BAD_REQUEST);
        assert.calledWith(log, ['PR', 'skipping']);
      });
    });
  });
});
