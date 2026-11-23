import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { WorkBoard, WorkMemberDock } from '../src/client/work-board.js'

function mount(component, props) {
  return new JSDOM(renderToStaticMarkup(h(component, props))).window
}

test('the Work view identifies a Ticket and shows the same status copy as the Main card', () => {
  const window = mount(WorkBoard, { items: [
    { id: 'item-running', ticketId: 'ticket-running', goal: 'Check the report', state: 'running', detail: 'running', createdAt: 1 },
    { id: 'item-waiting', ticketId: 'ticket-waiting', goal: 'Review the export', state: 'waiting-human', detail: 'waiting', createdAt: 2 },
    { id: 'item-failed', ticketId: 'ticket-failed', goal: 'Write the note', state: 'waiting-human', detail: 'failed', createdAt: 3 },
    { id: 'item-complete', ticketId: 'ticket-complete', goal: 'Format the summary', state: 'delivered', detail: 'success', createdAt: 4 },
  ] })
  try {
    const status = ticket => window.document.querySelector(`[data-ticket-id="${ticket}"] [role=status]`)?.textContent
    assert.equal(status('ticket-running'), 'Running work')
    assert.equal(status('ticket-waiting'), 'Waiting for an answer')
    assert.equal(status('ticket-failed'), 'Work failed')
    assert.equal(status('ticket-complete'), 'Work complete')
  } finally { window.close() }
})

test('Main, Router and Workers display their own activity as text and role marks', () => {
  const window = mount(WorkMemberDock, { activeTurn: { status: 'running' }, routing: true, workers: [
    { sessionId: 'working-worker', state: 'running', item: { goal: 'Working on the export' } },
    { sessionId: 'waiting-worker', state: 'waiting', item: { goal: 'Needs layout approval' } },
  ] })
  try {
    const rows = [...window.document.querySelectorAll('.bt-work-member')]
    assert.deepEqual(rows.map(row => row.querySelector('.bt-mark')?.dataset.state), ['thinking', 'orbit', 'working', 'alert'])
    assert.deepEqual(rows.map(row => row.querySelector('[data-role-status]')?.textContent),
      ['Replying', 'Routing work', 'Running work', 'Waiting for an answer'])
  } finally { window.close() }
})
