// One requestAnimationFrame loop for every animated overlay on the page.
//
// A page can carry dozens of overlays at once. Each one owning its own rAF would
// mean dozens of callbacks and dozens of chances to leak a live loop; instead
// they register a task here, and the loop runs only while at least one is
// registered.

export type FrameTask = (now: number) => void;

const tasks = new Set<FrameTask>();
let rafId = 0;

function tick(now: number) {
  rafId = 0;
  // Snapshot: a task may unregister itself (or another) mid-frame.
  for (const task of [...tasks]) task(now);
  if (tasks.size > 0) rafId = requestAnimationFrame(tick);
}

export function addFrameTask(task: FrameTask) {
  tasks.add(task);
  if (rafId === 0) rafId = requestAnimationFrame(tick);
}

export function removeFrameTask(task: FrameTask) {
  tasks.delete(task); // the loop winds itself down on its next frame
}
