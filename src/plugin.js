import btoa from 'btoa'
import groupBy from 'lodash.groupby'
import highwire from 'highwire'
import values from 'lodash.values'
import {ACCEPTED, BAD_REQUEST} from 'http-status-codes'
import FailedStatusFoundError from './failed-status-found-error'
import PendingTimeoutError from './pending-timeout-error'
import openedByGreenkeeperBot from './greenkeeper';

const MINUTE = 1000 * 60
const HOUR = MINUTE * 60

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_USER = process.env.GITHUB_USER
const SQUASH_MERGES = process.env.SQUASH_MERGES || false
const DELETE_BRANCHES = process.env.DELETE_BRANCHES || true

const { get, put, post, del } = highwire

const headers = {
  'Authorization': `Basic ${btoa(GITHUB_USER + ':' + GITHUB_TOKEN)}`
}

const mergePR = (prUrl, prNumber, sha) => {
  const mergeData = {
    sha,
    commit_title: `greenkeeper-keeper(pr: ${prNumber}): :white_check_mark:`,
    commit_message: `greenkeeper-keeper(pr: ${prNumber}): :white_check_mark:`,
    squash: SQUASH_MERGES
  }

  return put(`${prUrl}/merge`, mergeData, { headers })
}

const validatePR = (statusesUrl, timeout = MINUTE) =>
  get(statusesUrl, { headers })
    .then((response) => response.body)
    .then((statuses) => {
      const contexts = values(groupBy(statuses, 'context'))
      const latest = contexts.map((c) => c.sort((a, b) => a.id < b.id)[0])
      const failed = latest.filter((s) => s.state === 'failure')
      const error = latest.filter((s) => s.state === 'error')
      const pending = latest.filter((s) => s.state === 'pending')

      console.info('validating PR', {
        timeout,
        statusesUrl,
        latest: latest,
        failed: failed.length,
        error: error.length,
        pending: pending.length
      })

      if (failed.length || error.length) {
        console.log('found failed, rejecting...')
        return Promise.reject(new FailedStatusFoundError())
      }

      if (pending.length) {
        if (timeout > HOUR) {
          console.log('pending timeout exceeded, rejecting...')
          return Promise.reject(new PendingTimeoutError())
        }

        console.log('retrying statuses for:', statusesUrl)
        return new Promise((resolve) => setTimeout(() => resolve(), timeout))
          .then(() => validatePR(statusesUrl, timeout * 2))
      }

      console.log('statuses verified, continuing...')
      return Promise.resolve()
    })

const deleteBranch = (head) => {
  const { repo } = head
  const path = `/repos/${repo.full_name}/git/refs/heads/${head.ref}`
  const url = `https://api.github.com${path}`

  return del(url, { headers })
}

const buildErrorComment = (message, prNumber) => {
  return {
    body: `greenkeeper-keeper(pr: ${prNumber}): :x: \`${message}\``
  }
}

const commentWithError = (commentsUrl, prNumber, error) => {
  return post(`${commentsUrl}`, buildErrorComment(error.message, prNumber), { headers })
}

function isValidGreenkeeperUpdate({event, action, sender}) {
  return event === 'pull_request' && action === 'opened' && openedByGreenkeeperBot(sender.html_url);
}

export function register (server, options, next) {
  server.route({
    method: 'POST',
    path: '/payload',
    handler (request, response) {
      const { action, sender, pull_request, number } = request.payload

      if (isValidGreenkeeperUpdate({event: request.headers['x-github-event'], action, sender})) {
        response('ok').code(ACCEPTED);

        request.log(['info', 'PR', 'validating'], pull_request.url)
        validatePR(pull_request.statuses_url)
          .then(() => request.log(['info', 'PR', 'validated']))
          .then(() => mergePR(
            pull_request.url,
            number,
            pull_request.head.sha
          ))
          .then(() => request.log(['info', 'PR', 'merged'], pull_request.url))
          .then(() => {
            if (DELETE_BRANCHES) {
              return deleteBranch(pull_request.head)
            }

            return Promise.resolve()
          })
          .catch((error) => {
            request.log(['error', 'PR'], error)
            commentWithError(pull_request.comments_url, number, error).catch(e => request.log(
              ['error', 'PR'],
              `failed to post comment: ${e}`
            ))
          })
      } else {
        response('skipping').code(BAD_REQUEST);
        request.log(['PR', 'skipping'])
      }
    }
  })

  next()
}

register.attributes = {
  pkg: require('../package.json')
}