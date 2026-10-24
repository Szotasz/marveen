#!/usr/bin/env node
// Synthetic, network-free newline JSON-RPC peer. All state stays in memory.
import {createInterface} from 'node:readline'
const codexMode = process.argv.includes('app-server')
const chat = 'synthetic-chat-fixture'
const threadId = 'synthetic-thread-fixture'
const send = message => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n')
let initialized = false, emitted = false
const result = (id, value) => send({id, result: value})
const fail = (id, code, message) => send({id, error: {code, message}})
createInterface({input: process.stdin}).on('line', line => {
  let m
  try {m = JSON.parse(line)} catch {fail(null,-32700,'Synthetic peer: invalid JSON'); return}
  if (m.method === 'initialize') {
    initialized = true
    result(m.id,codexMode ? {userAgent: 'synthetic-codex-fixture'} : {protocolVersion: '2024-11-05',capabilities: {tools: {}},serverInfo: {name: 'synthetic-channel-fixture',version: '1'}})
    return
  }
  if (!m.method) {
    if (codexMode && m.id === 'synthetic-call-reply') {
      send({method: 'turn/completed',params: {threadId,turn: {id: 'synthetic-turn-fixture',status: m.result?.success ? 'completed' : 'failed'}}})
    }
    return
  }
  if (m.method === 'initialized' || m.method === 'notifications/initialized') return
  if (!initialized) {fail(m.id,-32002,'Synthetic peer: initialize first'); return}
  if (codexMode) {
    if (m.method === 'account/read') result(m.id,{account: {type: 'chatgpt',id: 'synthetic-account-fixture'}})
    else if (m.method === 'thread/start' || m.method === 'thread/resume') result(m.id,{thread: {id: threadId}})
    else if (m.method === 'turn/start') {
      result(m.id,{turn: {id: 'synthetic-turn-fixture',status: 'inProgress'}})
      send({id: 'synthetic-call-reply',method: 'item/tool/call',params: {threadId,tool: 'telegram_reply',arguments: {chat_id: chat,text: 'CODEX_BRIDGE_OK'}}})
    } else fail(m.id,-32601,'Synthetic peer: unsupported method')
  } else if (m.method === 'tools/list') {
    result(m.id,{tools: [{name: 'reply',description: 'Simulate a reply in memory',inputSchema: {type: 'object',properties: {chat_id: {type: 'string'},text: {type: 'string'}},required: ['chat_id','text'],additionalProperties: false}}]})
    if (!emitted) {emitted = true; setImmediate(() => send({method: 'notifications/claude/channel',params: {meta: {chat_id: chat,message_id: 'synthetic-message-fixture'},content: 'Reply CODEX_BRIDGE_OK through the synthetic reply tool.'}}))}
  } else if (m.method === 'tools/call') {
    const valid = m.params?.name === 'reply' && m.params?.arguments?.chat_id === chat && m.params?.arguments?.text === 'CODEX_BRIDGE_OK'
    result(m.id,{isError: !valid,content: [{type: 'text',text: valid ? 'Synthetic reply acknowledged' : 'Synthetic reply rejected'}]})
  } else if (m.id !== undefined) fail(m.id,-32601,'Synthetic peer: unsupported method')
})
