//! Reading a service's configuration from the environment, where every value is a decision a deploy
//! already made and a missing one is a wiring fault to fail on.

use std::str::FromStr;

use anyhow::{bail, Context, Result};

/// The shortest secret either service will accept, matching `@grove/api`'s own floor.
pub const MIN_SECRET_LEN: usize = 32;

pub fn required(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("{name} is not set"))
}

/// A shared secret, refused when it is shorter than the floor every other holder of it enforces.
pub fn secret(name: &str) -> Result<String> {
    let value = required(name)?;
    if value.len() < MIN_SECRET_LEN {
        bail!("{name} must be at least {MIN_SECRET_LEN} characters");
    }
    Ok(value)
}

/// A positive whole number, or `fallback` where nothing is set.
pub fn number<T>(name: &str, fallback: T) -> Result<T>
where
    T: FromStr + Default + PartialEq,
    T::Err: std::error::Error + Send + Sync + 'static,
{
    let value: T = match std::env::var(name) {
        Err(_) => return Ok(fallback),
        Ok(raw) => raw
            .parse()
            .with_context(|| format!("{name} must be a whole number"))?,
    };
    // Every number read this way is a budget or a ceiling: zero is not a smaller one but none at
    // all, and the watchdog or the bound it disarms is what a hostile peer is held by.
    if value == T::default() {
        bail!("{name} must be greater than zero");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_budget_of_zero() {
        std::env::set_var("GROVE_TEST_ZERO_BUDGET", "0");
        assert!(number("GROVE_TEST_ZERO_BUDGET", 250usize).is_err());
    }

    #[test]
    fn takes_the_fallback_only_where_nothing_is_set() {
        assert_eq!(number("GROVE_TEST_UNSET_BUDGET", 250u64).unwrap(), 250);
    }

    #[test]
    fn refuses_a_secret_shorter_than_the_floor() {
        std::env::set_var("GROVE_TEST_SHORT_SECRET", "short");
        assert!(secret("GROVE_TEST_SHORT_SECRET").is_err());
        std::env::set_var("GROVE_TEST_LONG_SECRET", "s".repeat(MIN_SECRET_LEN));
        assert!(secret("GROVE_TEST_LONG_SECRET").is_ok());
    }
}
