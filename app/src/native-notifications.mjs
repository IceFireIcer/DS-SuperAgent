import { PRODUCT_NAME } from './product.mjs'

const bodies = new Set(['Waiting for your answer', 'A new reply is waiting', '等你回答', '有一条新回复'])

export function createNativeNotifications({ Notification, onOpen, icon }) {
  let current
  let pending = false
  const clear = () => {
    const notice = current
    current = undefined
    notice?.close()
  }
  return {
    show(request) {
      if (request?.sessionId !== 'main' || !bodies.has(request.body)) throw new Error('Unknown product notification.')
      if (!Notification.isSupported()) throw new Error('This desktop does not provide native notifications.')
      clear()
      const notice = new Notification({ title: PRODUCT_NAME, body: request.body, icon })
      current = notice
      notice.once('click', () => {
        if (current !== notice) return
        pending = true
        onOpen()
      })
      const release = () => { if (current === notice) current = undefined }
      notice.once('close', release)
      notice.once('failed', release)
      notice.show()
    },
    takeOpen() {
      if (!pending) return null
      pending = false
      return 'main'
    },
    dispose() { clear(); pending = false },
  }
}
