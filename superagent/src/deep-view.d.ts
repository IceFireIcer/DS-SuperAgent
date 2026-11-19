declare module 'deep-view/core' {
  export function checkShownView(title: unknown, view: unknown): {
    title?: string
    view?: Record<string, unknown>
    interactive?: boolean
    error?: string
  }
  export function validateViewAnswer(view: unknown, action: unknown, values: unknown): {
    [key: string]: unknown
    error?: string
  }
  export function viewReply(record: unknown, action: unknown, values: unknown, sourceKind?: string): {
    text: string
    source: { kind: string; callId: string; outcome: 'answered' }
  } | undefined
  export function viewReplyText(text: string): string
}
