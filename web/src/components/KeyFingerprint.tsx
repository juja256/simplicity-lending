import { groupFingerprint } from '@/privateLending/offerView'

interface KeyFingerprintProps {
  /** `keyFingerprint` of the key: 16 hex characters. */
  fingerprint: string
  /**
   * The key's directory name, from its verified entry only (`useDirectory().lookup`): the key
   * signed it, but whoever holds the key chose it, so it is not an identity. It is isolated in
   * `<bdi>` and always shown next to the fingerprint.
   */
  name?: string | null
  size?: 'sm' | 'lg'
}

/** A lending key as people compare it: its fingerprint in 4×4 groups, after its directory name. */
export default function KeyFingerprint({ fingerprint, name, size = 'sm' }: KeyFingerprintProps) {
  return (
    <span
      className={`inline-flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 ${
        size === 'lg' ? 'text-base' : 'text-sm'
      }`}
    >
      {name ? (
        <bdi className='text-foreground max-w-64 truncate font-medium' title={name}>
          {name}
        </bdi>
      ) : null}
      <span
        className={`font-mono whitespace-nowrap tabular-nums ${
          size === 'lg' ? 'text-foreground text-base' : 'text-muted text-xs'
        }`}
        title='Key fingerprint'
      >
        {groupFingerprint(fingerprint)}
      </span>
    </span>
  )
}
