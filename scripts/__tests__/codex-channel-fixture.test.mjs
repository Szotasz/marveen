import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {JsonRpcProcess} from '../lib/codex-rpc.mjs'
const fixture=new URL('./fixtures/codex-channel.mjs',import.meta.url)
test('synthetic stdio peer honors initialization, notification and reply protocol',{timeout:5000},async()=>{
  const rpc=new JsonRpcProcess(process.execPath,[fixture.pathname])
  try {
    await assert.rejects(rpc.request('tools/list'),/initialize first/)
    const init=await rpc.request('initialize',{})
    assert.equal(init.protocolVersion,'2024-11-05')
    rpc.notify('notifications/initialized')
    const incoming=once(rpc,'message')
    const {tools}=await rpc.request('tools/list')
    assert.equal(tools[0].name,'reply')
    const [message]=await incoming
    assert.equal(message.params.meta.chat_id,'synthetic-chat-fixture')
    assert.equal(message.params.meta.message_id,'synthetic-message-fixture')
    const args={chat_id:'synthetic-chat-fixture',text:'CODEX_BRIDGE_OK'}
    assert.equal((await rpc.request('tools/call',{name:'reply',arguments:args})).isError,false)
    assert.equal((await rpc.request('tools/call',{name:'reply',arguments:{...args,chat_id:'synthetic-wrong-chat'}})).isError,true)
  }finally{rpc.close()}
})
