/**
 * 轮询读到的数据和上一次相同时返回上一次的对象。
 *
 * React 把状态设成同一个对象时不会重新渲染；轮询每次都会解析出新对象，内容没变也会让整页重绘。
 * 数据来自后端 JSON，按 JSON 文本比较即可。
 *
 * @param previous 上一次的状态值。
 * @param next 这次读到的值。
 * @returns 内容相同返回 previous，否则返回 next。
 */
export function keepIfEqual<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}
