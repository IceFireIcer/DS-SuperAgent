// Headers added by delivery adapters are transport metadata, not Main's reply.
export const HEADER = /^\[(Message from|Reply from|Group chat|Group post from|Bot team setup|Handoff · part|Secret card)(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/

export const stripHeader = text => text.replace(HEADER, '')
