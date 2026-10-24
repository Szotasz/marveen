import {describe,it,expect} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import Database from 'better-sqlite3'
import {DeliveryRecoveryStore,sendDurableNotice} from '../codex-recovery.js'
import {CodexDeliveryStore} from '../codex-delivery.js'
import {initDatabase,insertPendingTaskRetryIfNew,listPendingTaskRetries} from '../db.js'

function fixture(run: (store: DeliveryRecoveryStore,path: string) => Promise<void> | void) {
  const root=mkdtempSync(join(tmpdir(),'synthetic-recovery-')),path=join(root,'state.db')
  const store=new DeliveryRecoveryStore(path)
  return Promise.resolve().then(()=>run(store,path)).finally(()=>{store.close();rmSync(root,{recursive:true,force:true})})
}
const item={params:{meta:{chat_id:'synthetic-chat',message_id:'synthetic-message'},content:'synthetic task'}}
describe('durable channel recovery',()=>{
  it('ambiguous legacy work cannot be claimed and migration is repeatable',()=>fixture(store=>{
    const a=store.prepareChannel(item),b=store.prepareChannel(item)
    expect(a.deliveryId).toBe(b.deliveryId)
    expect(a).toMatchObject({status:'interrupted',reviewState:'manual_review',attemptCount:0})
    expect(store.claimChannel(false)).toBeNull()
  }))
  it('new work is claimed once; crash after side effect cannot run again',()=>fixture((store,path)=>{
    const a=store.prepareChannel(item,true)
    expect(store.claimChannel(false)?.deliveryId).toBe(a.deliveryId)
    const restart=new DeliveryRecoveryStore(path)
    try {
      expect(restart.recoverChannels()).toBe(1)
      expect(restart.prepareChannel(item,true).status).toBe('interrupted')
      expect(restart.claimChannel(false)).toBeNull()
      expect(restart.getChannel(a.deliveryId)?.attemptCount).toBe(1)
    } finally {restart.close()}
  }))
  it('keeps rotation deferred while any durable channel delivery is queued or running',()=>fixture(store=>{
    expect(store.hasActiveChannels()).toBe(false)
    const row=store.prepareChannel(item,true)
    expect(store.hasActiveChannels()).toBe(true)
    store.claimChannel(false)
    expect(store.hasActiveChannels()).toBe(true)
    store.finishChannel(row.deliveryId,'completed')
    expect(store.hasActiveChannels()).toBe(false)
  }))
  it('finished work deduplicates new intake after restart',()=>fixture((store,path)=>{
    const a=store.prepareChannel(item,true);store.claimChannel(false);store.finishChannel(a.deliveryId,'completed')
    const other=new DeliveryRecoveryStore(path)
    try {expect(other.prepareChannel(item,true).status).toBe('completed');expect(other.claimChannel(false)).toBeNull()}finally{other.close()}
  }))
})
describe('durable notification crash windows',()=>{
  it('crash before send preserves pending; only confirmed success becomes sent',()=>fixture(async(store,path)=>{
    const n=store.prepareNotice('synthetic-delivery');const restarted=new DeliveryRecoveryStore(path)
    try {
      restarted.recoverNotices();let sends=0
      expect(await sendDurableNotice(restarted,n.notificationId,async()=>{sends++;expect(restarted.getNotice(n.notificationId)?.status).toBe('sending')})).toBe(true)
      expect(restarted.getNotice(n.notificationId)?.status).toBe('sent')
      expect(await sendDurableNotice(restarted,n.notificationId,async()=>{sends++})).toBe(false)
      expect(sends).toBe(1)
    }finally{restarted.close()}
  }))
  it.each(['before-external-send','after-external-send'])('crash %s with sending state becomes manual_review, never resent',()=>fixture(async(store,path)=>{
    const n=store.prepareNotice('synthetic-delivery');store.claimNotice(n.notificationId)
    const restarted=new DeliveryRecoveryStore(path)
    try {
      expect(restarted.recoverNotices()).toBe(1)
      expect(restarted.getNotice(n.notificationId)?.status).toBe('manual_review')
      let sends=0;await sendDurableNotice(restarted,n.notificationId,async()=>{sends++});expect(sends).toBe(0)
      expect(restarted.listUnconfirmed()).toHaveLength(1)
    }finally{restarted.close()}
  }))
  it('known unsent failure is failed; uncertain transport failure is manual_review',()=>fixture(async store=>{
    for(const certain of [true,false]){
      const n=store.prepareNotice('synthetic-'+certain)
      await expect(sendDurableNotice(store,n.notificationId,async()=>{throw Object.assign(new Error('synthetic failure'),{definitelyNotSent:certain})})).rejects.toThrow()
      expect(store.getNotice(n.notificationId)?.status).toBe(certain?'failed':'manual_review')
    }
  }))
  it('legacy pre-send stamp is not upgraded to proof of delivery',()=>fixture((store,path)=>{
    const db=new Database(path)
    db.exec('CREATE TABLE codex_deliveries(delivery_id TEXT,notified_at INTEGER)')
    db.prepare('INSERT INTO codex_deliveries VALUES (?,?)').run('synthetic-old',1)
    store.recoverNotices()
    expect(store.prepareNotice('synthetic-old').status).toBe('manual_review')
    db.close()
  }))
})
describe('same cron identity through normal, retry and restart catchup',()=>{
  it('persists original occurrence, not first_attempt, and survives missing last-run file',()=>fixture((_store,path)=>{
    initDatabase(path)
    const occurrence=1800000,firstAttempt=occurrence+12345
    insertPendingTaskRetryIfNew('synthetic-task','synthetic-agent',firstAttempt,'busy',occurrence)
    const retry=listPendingTaskRetries().find(r=>r.task_name==='synthetic-task')!
    expect(retry.first_attempt).not.toBe(retry.scheduled_occurrence)
    expect(retry.scheduled_occurrence).toBe(occurrence)
    const input={taskId:'synthetic-task',agentId:'synthetic-agent',prompt:'synthetic',scheduledOccurrence:occurrence}
    const normal=new CodexDeliveryStore(path)
    const first=normal.prepare(input).delivery;normal.close()
    const restart=new CodexDeliveryStore(path)
    try {
      const second=restart.prepare({...input,scheduledOccurrence:retry.scheduled_occurrence!})
      const catchup=restart.prepare(input)
      expect(second.created).toBe(false);expect(catchup.created).toBe(false)
      expect(second.delivery.deliveryId).toBe(first.deliveryId)
      const db=new Database(path)
      expect(db.prepare('SELECT COUNT(*) AS n FROM codex_deliveries').get()).toEqual({n:1})
      expect(db.prepare('SELECT scheduled_occurrence AS occurrence FROM task_runs WHERE id=?').get(first.taskRunId)).toEqual({occurrence})
      expect(()=>db.prepare('INSERT INTO codex_deliveries SELECT ?,?,task_id,agent_id,scheduled_occurrence,999,queued_at,started_at,finished_at,status,attempt_count,error_code,error_summary,review_state,prompt,notified_at,escalated_at FROM codex_deliveries').run('synthetic-other-id','synthetic-other-key')).toThrow()
      db.close()
    }finally{restart.close()}
  }))
})
