// `.e2e-private/state.json`: one record per stage, so a re-run skips what is already on chain.
import fs from 'node:fs'
import path from 'node:path'

import { webRoot } from './env'

export interface StageRecord {
  stage: string
  txid: string
  hex: string
  status: 'built' | 'broadcast' | 'confirmed'
}

const stateFile = path.join(webRoot, '.e2e-private/state.json')

function readAll(): Record<string, StageRecord> {
  if (!fs.existsSync(stateFile)) return {}
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as Record<string, StageRecord>
}

export function getRecord(stage: string): StageRecord | undefined {
  return readAll()[stage]
}

export function saveRecord(record: StageRecord): void {
  const all = readAll()
  all[record.stage] = record
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, `${JSON.stringify(all, null, 2)}\n`)
}
