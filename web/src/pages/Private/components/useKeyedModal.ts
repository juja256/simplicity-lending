import { useCallback, useState } from 'react'

/**
 * One modal at a time, opened with a request. Each opening gets a fresh key, so it starts with
 * fresh state, and the last request stays mounted while its modal closes.
 */
export function useKeyedModal<T>() {
  const [modal, setModal] = useState<{ key: number; request: T } | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const open = useCallback((request: T) => {
    setModal(previous => ({ key: (previous?.key ?? 0) + 1, request }))
    setIsOpen(true)
  }, [])
  const close = useCallback(() => setIsOpen(false), [])
  return { modal, isOpen, open, close }
}
