// The dashboard's own operations on skill directories run one at a time. While
// zip and cp ran synchronously (before #2189) that came for free: no other
// request could run while an export zipped the global root or an assign copied
// a skill. Now the zip / cp child keeps running across an await, so a delete or
// an approval could change a directory under it: zip exits 18 on a file removed
// after its scan (the export then fails with 500), and a copy can take half of a
// skill. Export, assign, approve, delete and the fleet import go through this queue. Writers
// outside the dashboard (an agent editing its own skills) are not covered, as
// they never were.
let skillsDirQueue: Promise<unknown> = Promise.resolve()

export function serializeSkillsDir<T>(op: () => Promise<T> | T): Promise<T> {
  const run = skillsDirQueue.then(op)
  skillsDirQueue = run.catch(() => {})
  return run
}
