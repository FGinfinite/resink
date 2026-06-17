export interface Reference {
  type: 'file' | 'selection'
  path: string
  startLine?: number
  endLine?: number
  selectionText?: string
}
