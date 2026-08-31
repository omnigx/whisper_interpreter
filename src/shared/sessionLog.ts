/** One JSONL line written under logs/ */
export interface SessionLogEntry {
  timestamp: string
  module: 'STT' | 'LLM' | string
  model_name: string
  content: string
  latency?: number
  /** LLM entries: the source sentence that produced `content` */
  source_text?: string
}
