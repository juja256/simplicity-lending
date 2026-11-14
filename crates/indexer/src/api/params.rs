use serde::Deserialize;
use serde::de::Error;

/// Query params are always strings; `#[serde(flatten)]` does not coerce them to integers.
pub(crate) fn deserialize_optional_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    value
        .map(|s| s.parse().map_err(D::Error::custom))
        .transpose()
}
