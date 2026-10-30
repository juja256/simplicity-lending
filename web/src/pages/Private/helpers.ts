// The directory's display-name rule, which only the page's directory form uses. The rules shared
// with the modals live in `@/privateLending/offerView`.

/** The indexer's limit on a directory display name, in Unicode scalar values. */
export const MAX_DISPLAY_NAME_CHARS = 64

// Rust's `str::trim` strips `char::is_whitespace`, the Unicode White_Space property.
const EDGE_WHITESPACE = /^\p{White_Space}|\p{White_Space}$/u
// Rust's `char::is_control`: the Cc category.
const CONTROL_CHARACTER = /\p{Cc}/u
// A lone surrogate is not text: it cannot be sent as UTF-8.
const LONE_SURROGATE = /\p{Cs}/u

/**
 * Why the indexer would refuse a display name (`validate_display_name`: 1 to 64 characters, no
 * leading or trailing whitespace, no control characters), or null if it accepts it.
 */
export function displayNameError(name: string): string | null {
  if (LONE_SURROGATE.test(name)) return 'The name contains an invalid character.'
  const chars = [...name].length
  if (chars === 0 || chars > MAX_DISPLAY_NAME_CHARS) {
    return `A name has 1 to ${MAX_DISPLAY_NAME_CHARS} characters.`
  }
  if (EDGE_WHITESPACE.test(name)) return 'A name cannot start or end with a space.'
  if (CONTROL_CHARACTER.test(name)) return 'A name cannot contain control characters.'
  return null
}
