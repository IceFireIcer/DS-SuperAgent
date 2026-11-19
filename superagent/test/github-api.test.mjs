import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as core from '../dist/index.js'

const issuesPath = 'repos/acme/repo/issues?state=all&sort=updated&direction=asc&per_page=100&page=1'

test('the GitHub CLI transport maps a real issues/PR/review/CI snapshot into ordered events', async () => {
  const transport = new core.GitHubCliTransport()
  const responses = new Map([
    [issuesPath, [
      { id: 11, number: 1, state: 'open', title: 'Issue one', body: 'Issue detail', updated_at: '2026-01-01T00:00:00Z', user: { login: 'alice' } },
      { id: 12, number: 2, state: 'closed', title: 'PR two', body: 'PR detail', updated_at: '2026-01-02T00:00:00Z', user: { login: 'alice' },
        pull_request: { url: 'https://api.github.com/repos/acme/repo/pulls/2' } },
    ]],
    ['repos/acme/repo/pulls/2', { id: 12, number: 2, state: 'closed', merged_at: '2026-01-03T00:00:00Z', title: 'PR two', body: 'PR detail',
      updated_at: '2026-01-03T00:00:00Z', draft: false, user: { login: 'alice' }, head: { sha: 'sha-2' } }],
    ['repos/acme/repo/pulls/2/reviews?per_page=100&page=1', [{ id: 21, state: 'COMMENTED', body: 'Looks good', submitted_at: '2026-01-02T12:00:00Z', user: { login: 'bob' } }]],
    ['repos/acme/repo/commits/sha-2/check-runs?per_page=100&page=1', { total_count: 1, check_runs: [{ id: 31, name: 'test', status: 'completed', conclusion: 'success',
      started_at: '2026-01-03T00:05:00Z', completed_at: '2026-01-03T00:10:00Z', app: { slug: 'github-actions' } }] }],
    ['repos/acme/repo/issues/1/comments?per_page=100&page=1', []],
    ['repos/acme/repo/issues/2/comments?per_page=100&page=1', []],
    ['repos/acme/repo/issues/2/timeline?per_page=100&page=1', [{ event: 'merged', actor: { login: 'maintainer', type: 'User' },
      created_at: '2026-01-03T00:00:00Z' }]],
  ])
  const events = await transport.mapEvents(async path => path.includes('/comments?per_page=') ? []
    : responses.get(path) ?? responses.get(path.replace(/&page=1$/u, '')), 'acme', 'repo')
  assert.deepEqual(events.map(event => event.kind), ['issue', 'review', 'pull_request', 'ci'])
  assert.deepEqual(events.map(event => event.action), ['created', 'reviewed', 'merged', 'completed'])
  assert.equal(events[2].state, 'merged')
  assert.deepEqual([events[2].authorId, events[2].authorKind], ['maintainer', 'human'])
  assert.equal(events[2].number, 2)
  assert.equal(events[1].authorId, 'bob')
  assert.equal(events[3].authorKind, 'ci')
  assert.match(events[3].body, /Check run test success\./u)
  assert.deepEqual(events, [...events].sort((left, right) => left.cursor.localeCompare(right.cursor)))
  assert.equal(new Set(events.map(event => event.deliveryId)).size, events.length)
})

test('GitHub bot and CI actor kinds stay consistent for Issues, PRs and reviews', async () => {
  const transport = new core.GitHubCliTransport()
  const responses = new Map([
    [issuesPath, [
      { id: 41, number: 4, state: 'open', title: 'Bot issue', body: 'Automation', updated_at: '2026-01-04T00:00:00Z',
        user: { login: 'release-bot', type: 'Bot' } },
      { id: 42, number: 5, state: 'open', title: 'CI issue', body: 'Automation', updated_at: '2026-01-04T00:01:00Z',
        user: { login: 'github-actions[bot]', type: 'Bot' } },
      { id: 43, number: 6, state: 'open', title: 'Bot PR', body: 'Automation', updated_at: '2026-01-04T00:02:00Z',
        user: { login: 'release-bot', type: 'Bot' }, pull_request: { url: 'https://api.github.com/repos/acme/repo/pulls/6' } },
    ]],
    ['repos/acme/repo/pulls/6', { id: 43, number: 6, state: 'open', title: 'Bot PR', body: 'Automation',
      updated_at: '2026-01-04T00:02:00Z', user: { login: 'release-bot', type: 'Bot' }, head: { sha: 'sha-6' } }],
    ['repos/acme/repo/pulls/6/reviews?per_page=100&page=1', [{ id: 61, state: 'APPROVED', body: 'Automated review',
      submitted_at: '2026-01-04T00:03:00Z', user: { login: 'release-bot', type: 'Bot' } }]],
    ['repos/acme/repo/commits/sha-6/check-runs?per_page=100&page=1', { check_runs: [] }],
  ])
  const events = await transport.mapEvents(async path => path.includes('/comments?per_page=') ? []
    : responses.get(path) ?? responses.get(path.replace(/&page=1$/u, '')), 'acme', 'repo')
  const byKind = Object.groupBy(events, event => event.kind)
  assert.equal(byKind.issue.find(event => event.number === 4).authorKind, 'bot')
  assert.equal(byKind.issue.find(event => event.number === 5).authorKind, 'ci')
  assert.equal(byKind.pull_request[0].authorKind, 'bot')
  assert.equal(byKind.review[0].authorKind, 'bot')
})

test('edited and closed GitHub events use the native change actor instead of the creator', async () => {
  const transport = new core.GitHubCliTransport()
  const responses = new Map([
    [issuesPath, [
      { id: 71, number: 7, state: 'open', title: 'Collaborator edit', body: 'Edited', created_at: '2026-01-07T00:00:00Z',
        updated_at: '2026-01-07T00:01:00Z', user: { login: 'alice', type: 'User' },
        sender: { login: 'mallory', type: 'User' } },
      { id: 72, number: 8, state: 'closed', title: 'Bot close', body: 'Closed', created_at: '2026-01-08T00:00:00Z',
        updated_at: '2026-01-08T00:01:00Z', user: { login: 'alice', type: 'User' },
        closed_by: { login: 'close-bot[bot]', type: 'Bot' } },
      { id: 73, number: 9, state: 'closed', title: 'CI PR close', body: 'Closed', created_at: '2026-01-09T00:00:00Z',
        updated_at: '2026-01-09T00:01:00Z', user: { login: 'alice', type: 'User' },
        sender: { login: 'github-actions[bot]', type: 'Bot' }, pull_request: { url: 'https://api.github.com/repos/acme/repo/pulls/9' } },
    ]],
    ['repos/acme/repo/pulls/9', { id: 73, number: 9, state: 'closed', title: 'CI PR close', body: 'Closed',
      created_at: '2026-01-09T00:00:00Z', updated_at: '2026-01-09T00:01:00Z', user: { login: 'alice', type: 'User' },
      sender: { login: 'github-actions[bot]', type: 'Bot' }, head: { sha: 'sha-9' } }],
    ['repos/acme/repo/pulls/9/reviews?per_page=100&page=1', []],
    ['repos/acme/repo/commits/sha-9/check-runs?per_page=100&page=1', { check_runs: [] }],
  ])
  const events = await transport.mapEvents(async path => path.includes('/comments?per_page=') ? []
    : responses.get(path) ?? responses.get(path.replace(/&page=1$/u, '')), 'acme', 'repo')
  const edited = events.find(event => event.kind === 'issue' && event.number === 7)
  const closed = events.find(event => event.kind === 'issue' && event.number === 8)
  const ciClosed = events.find(event => event.kind === 'pull_request' && event.number === 9)
  assert.deepEqual([edited.action, edited.authorId, edited.authorKind], ['edited', 'mallory', 'human'])
  assert.deepEqual([closed.action, closed.authorId, closed.authorKind], ['closed', 'close-bot[bot]', 'bot'])
  assert.deepEqual([ciClosed.action, ciClosed.authorId, ciClosed.authorKind], ['closed', 'github-actions[bot]', 'ci'])
})

test('changed GitHub snapshots enrich their actor from a bounded native timeline', async () => {
  const transport = new core.GitHubCliTransport()
  const responses = new Map([
    [issuesPath, [
      { id: 81, number: 8, state: 'open', title: 'Collaborator edit', body: 'Edited', created_at: '2026-01-08T00:00:00Z',
        updated_at: '2026-01-08T00:01:00Z', user: { login: 'alice', type: 'User' } },
      { id: 82, number: 9, state: 'open', title: 'Reopened request', body: 'Reopened', created_at: '2026-01-09T00:00:00Z',
        updated_at: '2026-01-09T00:01:00Z', user: { login: 'alice', type: 'User' } },
      { id: 83, number: 10, state: 'closed', title: 'Bot close', body: 'Closed', created_at: '2026-01-10T00:00:00Z',
        updated_at: '2026-01-10T00:01:00Z', user: { login: 'alice', type: 'User' } },
      { id: 84, number: 11, state: 'closed', title: 'CI cancel', body: 'Canceled', created_at: '2026-01-11T00:00:00Z',
        updated_at: '2026-01-11T00:01:00Z', user: { login: 'alice', type: 'User' } },
      { id: 85, number: 12, state: 'open', title: 'Unknown edit', body: 'Edited', created_at: '2026-01-12T00:00:00Z',
        updated_at: '2026-01-12T00:01:00Z', user: { login: 'alice', type: 'User' } },
    ]],
    ['repos/acme/repo/issues/8/timeline?per_page=100&page=1', [{ event: 'edited', actor: { login: 'mallory', type: 'User' },
      created_at: '2026-01-08T00:01:00Z' }]],
    ['repos/acme/repo/issues/9/timeline?per_page=100&page=1', [{ event: 'reopened', actor: { login: 'mallory', type: 'User' },
      created_at: '2026-01-09T00:01:00Z' }]],
    ['repos/acme/repo/issues/10/timeline?per_page=100&page=1', [{ event: 'closed', actor: { login: 'close-bot[bot]', type: 'Bot' },
      created_at: '2026-01-10T00:01:00Z' }]],
    ['repos/acme/repo/issues/11/timeline?per_page=100&page=1', [{ event: 'closed', actor: { login: 'github-actions[bot]', type: 'Bot' },
      created_at: '2026-01-11T00:01:00Z' }]],
    ['repos/acme/repo/issues/12/timeline?per_page=100&page=1', [{ event: 'edited',
      created_at: '2026-01-12T00:01:00Z' }]],
  ])
  const events = await transport.mapEvents(async path => path.includes('/comments?per_page=') ? [] : responses.get(path), 'acme', 'repo')
  const byNumber = new Map(events.map(event => [event.number, event]))
  assert.deepEqual([byNumber.get(8).action, byNumber.get(8).authorId, byNumber.get(8).authorKind], ['edited', 'mallory', 'human'])
  assert.deepEqual([byNumber.get(9).action, byNumber.get(9).authorId, byNumber.get(9).authorKind], ['reopened', 'mallory', 'human'])
  assert.deepEqual([byNumber.get(10).authorId, byNumber.get(10).authorKind], ['close-bot[bot]', 'bot'])
  assert.deepEqual([byNumber.get(11).authorId, byNumber.get(11).authorKind], ['github-actions[bot]', 'ci'])
  assert.deepEqual([byNumber.get(12).authorId, byNumber.get(12).authorKind], ['github', 'system'])
})

test('exhausted timeline enrichment keeps changed events unknown instead of failing the poll', async () => {
  const transport = new core.GitHubCliTransport()
  const issues = Array.from({ length: 61 }, (_, index) => {
    const createdAt = new Date(Date.UTC(2026, 0, index + 1))
    return { id: 1000 + index, number: index + 1, state: 'open', title: `Edited request ${index + 1}`, body: 'Edited',
      created_at: createdAt.toISOString(), updated_at: new Date(createdAt.getTime() + 60_000).toISOString(),
      user: { login: 'alice', type: 'User' } }
  })
  let timelineRequests = 0
  const events = await transport.mapEvents(async path => {
    if (path === issuesPath) return issues
    if (path.includes('/comments?per_page=')) return []
    assert.match(path, /\/issues\/\d+\/timeline\?/u)
    timelineRequests++
    return []
  }, 'acme', 'repo')
  assert.equal(events.length, 61)
  assert.equal(timelineRequests, 60)
  assert.deepEqual(events.map(event => [event.authorId, event.authorKind]), Array.from({ length: 61 }, () => ['github', 'system']))
})

test('the GitHub CLI transport pages through the issue list and refuses to overrun its budget', async () => {
  const transport = new core.GitHubCliTransport()
  const pages = []
  const runner = async path => {
    pages.push(path)
    if (path.includes('/comments?')) return []
    const page = Number(path.match(/&page=(\d+)$/u)?.[1])
    return page < 2 ? Array.from({ length: 100 }, (_, index) => ({ id: page * 1000 + index, number: page * 1000 + index, state: 'open',
      title: `Issue ${page}`, body: '', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', user: { login: 'alice' } })) : []
  }
  const events = await transport.mapEvents(runner, 'acme', 'repo')
  assert.equal(events.length, 100)
  assert.deepEqual(pages.filter(path => path.startsWith('repos/acme/repo/issues?')).map(path => path.split('&page=')[1]), ['1', '2'])
  const filler = async () => Array.from({ length: 100 }, (_, index) => ({ id: index, number: index + 1,
    state: 'open', title: 'Filler', body: '', updated_at: '2026-01-01T00:00:00Z', user: { login: 'alice' } }))
  await assert.rejects(transport.mapEvents(filler, 'acme', 'repo'), { code: 'SOURCE_BUDGET' })
})

test('a missing pull request becomes deletion evidence instead of a source failure', async () => {
  const transport = new core.GitHubCliTransport()
  const runner = async (path, request) => {
    if (path === issuesPath) return [{ id: 12, number: 2, state: 'open', title: 'PR two', updated_at: '2026-01-02T00:00:00Z', user: { login: 'alice' },
      pull_request: { url: 'https://api.github.com/repos/acme/repo/pulls/2' } }]
    if (path === 'repos/acme/repo/pulls/2') {
      assert.deepEqual(request, { allowMissing: true })
      return undefined
    }
    if (path === 'repos/acme/repo/issues/2/timeline?per_page=100&page=1') return []
    throw new Error(`Unexpected GitHub API path ${path}`)
  }
  const events = await transport.mapEvents(runner, 'acme', 'repo')
  assert.equal(events.length, 1)
  assert.equal(events[0].action, 'deleted')
  assert.equal(events[0].kind, 'pull_request')
  assert.deepEqual([events[0].authorId, events[0].authorKind], ['github', 'system'])
  assert.match(events[0].deletionEvidence, /404/u)
})

test('an API failure that is not a missing resource stays a source failure', async () => {
  const transport = new core.GitHubCliTransport()
  const runner = async path => {
    if (path === issuesPath) {
      return [{ id: 13, number: 3, state: 'open', title: 'PR three', updated_at: '2026-01-02T00:00:00Z', user: { login: 'alice' },
        pull_request: { url: 'https://api.github.com/repos/acme/repo/pulls/3' } }]
    }
    throw new core.CoreError('SOURCE_FAILED', 'GitHub API request failed for repos/acme/repo/pulls/3: gh: Server Error (HTTP 500)')
  }
  await assert.rejects(transport.mapEvents(runner, 'acme', 'repo'), { code: 'SOURCE_FAILED' })
})

test('only the documented HTTP status counts as a missing resource', () => {
  assert.equal(core.isMissingResource('gh: Not Found (HTTP 404)'), true)
  assert.equal(core.isMissingResource('GitHub API request failed for repos/acme/repo/pulls/404: gh: Server Error (HTTP 500)'), false)
})

test('ordinary issue and PR comments are numbered natively and paged without truncation', async () => {
  const transport = new core.GitHubCliTransport()
  const comments = Array.from({ length: 101 }, (_, index) => ({ id: 41 + index, body: `Comment ${index}.`,
    created_at: '2026-01-01T00:00:00Z', updated_at: index === 0 ? '2026-01-01T00:00:05Z' : '2026-01-01T00:00:00Z',
    user: { login: 'alice', type: 'User' } }))
  const page = path => Number(path.match(/[&?]page=(\d+)$/u)?.[1] ?? '1')
  const runner = async path => {
    if (path === issuesPath) return [
      { id: 11, number: 1, state: 'open', title: 'Issue one', body: '', created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z', user: { login: 'alice' } },
      { id: 12, number: 2, state: 'open', title: 'PR two', body: '', created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z', user: { login: 'alice' }, pull_request: { url: 'https://api.github.com/repos/acme/repo/pulls/2' } },
    ]
    if (path.startsWith(issuesPath.replace('&page=1', '&page=2'))) return []
    if (path.includes('/timeline?per_page=')) return []
    if (path === 'repos/acme/repo/pulls/2') return { id: 12, number: 2, state: 'open', title: 'PR two', body: '', updated_at: '2026-01-02T00:00:00Z',
      draft: false, user: { login: 'alice' }, head: { sha: 'sha-2' } }
    if (path === 'repos/acme/repo/pulls/2/reviews?per_page=100&page=1') return []
    if (path === 'repos/acme/repo/commits/sha-2/check-runs?per_page=100&page=1') return { total_count: 0, check_runs: [] }
    if (path.startsWith('repos/acme/repo/issues/1/comments?per_page=100&page=')) {
      const current = page(path)
      return comments.slice((current - 1) * 100, current * 100)
    }
    if (path === 'repos/acme/repo/issues/2/comments?per_page=100&page=1') return [{ id: 151, body: 'PR discussion.', created_at: '2026-01-03T00:00:00Z',
      updated_at: '2026-01-03T00:00:00Z', user: { login: 'release-bot', type: 'Bot' } }]
    throw new Error(`Unexpected GitHub API path ${path}`)
  }
  const events = await transport.mapEvents(runner, 'acme', 'repo')
  const commentEvents = events.filter(event => event.kind === 'comment')
  assert.equal(commentEvents.length, 102)
  assert.equal(commentEvents.find(event => event.id === '41').number, 1)
  assert.equal(commentEvents.find(event => event.id === '41').action, 'edited')
  assert.equal(commentEvents.find(event => event.id === '41').authorKind, 'system')
  assert.equal(commentEvents.find(event => event.id === '141').body, 'Comment 100.')
  assert.equal(commentEvents.find(event => event.id === '151').authorKind, 'bot')
})

test('PR reviews and check runs are paged instead of treating the first page as the snapshot', async () => {
  const transport = new core.GitHubCliTransport()
  const reviews = Array.from({ length: 101 }, (_, index) => ({ id: 200 + index, state: 'COMMENTED', body: `Review ${index}.`,
    submitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), user: { login: 'bob' } }))
  const checks = Array.from({ length: 101 }, (_, index) => ({ id: 400 + index, name: `check-${index}`, status: 'completed', conclusion: 'success',
    started_at: new Date(Date.UTC(2026, 0, 1, 0, 1, index)).toISOString(), completed_at: new Date(Date.UTC(2026, 0, 1, 0, 2, index)).toISOString(),
    app: { slug: 'github-actions' } }))
  const page = path => Number(path.match(/[&?]page=(\d+)$/u)?.[1] ?? '1')
  const calls = []
  const runner = async path => {
    calls.push(path)
    if (path === issuesPath) return [{ id: 12, number: 2, state: 'open', title: 'PR two', body: '', created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z', user: { login: 'alice' }, pull_request: { url: 'https://api.github.com/repos/acme/repo/pulls/2' } }]
    if (path === 'repos/acme/repo/issues?state=all&sort=updated&direction=asc&per_page=100&page=2') return []
    if (path === 'repos/acme/repo/pulls/2') return { id: 12, number: 2, state: 'open', title: 'PR two', body: '', updated_at: '2026-01-02T00:00:00Z',
      draft: false, user: { login: 'alice' }, head: { sha: 'sha-2' } }
    if (path.startsWith('repos/acme/repo/pulls/2/reviews?per_page=100&page=')) {
      const current = page(path)
      return reviews.slice((current - 1) * 100, current * 100)
    }
    if (path.startsWith('repos/acme/repo/commits/sha-2/check-runs?per_page=100&page=')) {
      const current = page(path)
      return { total_count: checks.length, check_runs: checks.slice((current - 1) * 100, current * 100) }
    }
    if (path === 'repos/acme/repo/issues/2/comments?per_page=100&page=1') return []
    throw new Error(`Unexpected GitHub API path ${path}`)
  }
  const events = await transport.mapEvents(runner, 'acme', 'repo')
  assert.equal(events.filter(event => event.kind === 'review').length, 101)
  assert.equal(events.filter(event => event.kind === 'ci').length, 101)
  assert.ok(calls.includes('repos/acme/repo/pulls/2/reviews?per_page=100&page=2'))
  assert.ok(calls.includes('repos/acme/repo/commits/sha-2/check-runs?per_page=100&page=2'))
})

test('the CLI transport filters by the durable cursor and refuses an aborted request', async () => {
  const transport = new core.GitHubCliTransport({ runner: async path => path.includes('/comments?') ? [] : [
    { id: 1, number: 1, state: 'open', title: 'Old', body: '', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', user: { login: 'alice' } },
    { id: 2, number: 2, state: 'open', title: 'New', body: '', created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', user: { login: 'alice' } },
  ] })
  const result = await transport.listEvents({ owner: 'acme', repo: 'repo', cursor: '2026-01-15T00:00:00Z#issue#000000000001',
    signal: new AbortController().signal })
  assert.deepEqual(result.events.map(event => event.number), [2])
  await assert.rejects(transport.listEvents({ owner: 'acme', repo: 'repo', signal: AbortSignal.abort() }), { name: 'AbortError' })
})
