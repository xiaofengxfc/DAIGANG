import { startApplication } from './src/server/app.mjs'

const app = startApplication()

/**
 * 桌面外壳退出前会先发这条消息。
 *
 * 为什么需要它：Windows 上外壳 `kill()` 一个子进程等于 TerminateProcess，
 * 这个进程的 SIGTERM 处理器根本不会跑 —— 数据库的 WAL 来不及合并，
 * 由后端拉起的 Python 视觉进程也要靠「父进程的 stdin 断了」才肯退出。
 * 走这条明路，`shutdown()` 才会真的执行：停调度、停 sidecar、锁保险箱、关库。
 *
 * 用 node 直接跑（npm start）时没有任何父进程发消息，这个监听器什么也不做。
 */
process.on('message', (msg) => {
  if (msg && msg.type === 'shutdown') app.shutdown('desktop')
})
