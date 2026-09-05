//! Real time into ticks. The same policy `packages/glue/src/server/driver.ts` runs in process, and
//! the two have to agree: a game behaves differently under a shed, so a divergence here is a
//! divergence a playtest cannot reproduce.

/// Slack on the accumulator's `>= dt` test: a host advancing by exactly `1 / sim_rate` rounds short,
/// and a wake owing one tick would step zero times.
const STEP_EPSILON: f64 = 1e-9;

/// Wall-clock one wake may catch up before it sheds, sized so a stalled host drains without shedding.
pub const MAX_CATCHUP_MS: f64 = 250.0;

/// Ticks one wake may step before it sheds the rest as wall-clock.
pub fn max_steps_per_wake(sim_rate: f64) -> u32 {
    ((MAX_CATCHUP_MS / 1000.0) * sim_rate).ceil().max(1.0) as u32
}

/// Ticks between broadcasts, never below one.
pub fn ticks_per_send(sim_rate: f64, send_rate: f64) -> u32 {
    // NaN answers one, like a rate of zero: this is asked on every wake and must never divide by
    // something that has no ordering.
    if !send_rate.is_finite() || send_rate <= 0.0 {
        return 1;
    }
    ((sim_rate / send_rate).round() as u32).max(1)
}

/// What one wake did, so cadence and shedding are observable rather than inferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Wake {
    pub steps: u32,
    pub sends: u32,
    /// True when the cap was hit with backlog left over, and that backlog was shed.
    pub shed: bool,
}

/// The accumulator, the step cap, and the send cadence.
///
/// It steps nothing itself: `wake` reports how many ticks are owed and which of them drain, and the
/// caller runs them. That keeps the isolate — which is neither `Send` nor re-entrant — off the far
/// side of a callback.
pub struct Clock {
    sim_rate: f64,
    send_rate: f64,
    accumulator: f64,
    last_now: Option<f64>,
    /// Ticks since the last broadcast, counted here rather than derived from the tick index, so a
    /// mid-session rate change cannot desync it.
    since_send: u32,
    shed_count: u64,
    now_seconds: f64,
}

impl Clock {
    pub fn new(sim_rate: f64, send_rate: f64) -> Self {
        assert!(
            sim_rate.is_finite() && sim_rate > 0.0,
            "simRate must be positive and finite"
        );
        assert!(
            send_rate.is_finite() && send_rate > 0.0,
            "sendRate must be positive and finite"
        );
        Self {
            sim_rate,
            send_rate,
            accumulator: 0.0,
            last_now: None,
            since_send: 0,
            shed_count: 0,
            now_seconds: 0.0,
        }
    }

    /// The clock the last wake reported — the host's only reading of time.
    pub fn now_seconds(&self) -> f64 {
        self.now_seconds
    }

    /// How many times the cap has shed a backlog — a visible slowdown, not a silent one.
    pub fn shed_count(&self) -> u64 {
        self.shed_count
    }

    /// One wake. Returns the ticks owed, and `drains` says which of them close a send interval.
    ///
    /// The caller must run exactly `steps` ticks and mark exactly the ones `drains` names, or the
    /// cadence and the accumulator disagree from here on.
    pub fn wake(&mut self, now_seconds: f64, drains: &mut Vec<bool>) -> Wake {
        drains.clear();

        // Discarded, never stored: stored, every later `now - last` is NaN, so one bad reading
        // freezes the counter for the session rather than for a wake.
        if !now_seconds.is_finite() {
            return Wake::default();
        }

        self.now_seconds = now_seconds;
        let last = *self.last_now.get_or_insert(now_seconds);

        let dt = 1.0 / self.sim_rate;
        // Clamped rather than subtracted: an NTP correction or a restored snapshot arrives as a
        // reading behind the last one, and a negative delta would rewind the accumulator.
        self.accumulator += (now_seconds - last).max(0.0);
        self.last_now = Some(now_seconds);

        let cap = max_steps_per_wake(self.sim_rate);
        let per_send = ticks_per_send(self.sim_rate, self.send_rate);
        let owed = dt - STEP_EPSILON;

        let mut out = Wake::default();
        while self.accumulator >= owed && out.steps < cap {
            self.accumulator -= dt;
            self.since_send += 1;
            let drain = self.since_send >= per_send;
            if drain {
                self.since_send = 0;
                out.sends += 1;
            }
            drains.push(drain);
            out.steps += 1;
        }

        // Conditioned on leftover backlog: a wake that needed exactly the cap and drained cleanly
        // has a legitimate fractional remainder that zeroing would discard.
        out.shed = out.steps == cap && self.accumulator >= owed;
        if out.shed {
            self.accumulator = 0.0;
            self.shed_count += 1;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_k_steps_for_k_ticks_and_carries_the_remainder() {
        let mut clock = Clock::new(60.0, 20.0);
        let mut drains = Vec::new();
        let dt = 1.0 / 60.0;
        clock.wake(0.0, &mut drains);
        assert_eq!(clock.wake(5.0 * dt, &mut drains).steps, 5);
        assert_eq!(clock.wake(5.0 * dt + dt / 2.0, &mut drains).steps, 0);
        assert_eq!(clock.wake(6.0 * dt + dt / 2.0, &mut drains).steps, 1);
    }

    #[test]
    fn a_backwards_clock_is_inert() {
        let mut clock = Clock::new(60.0, 20.0);
        let mut drains = Vec::new();
        clock.wake(0.0, &mut drains);
        clock.wake(1.0, &mut drains);
        assert_eq!(clock.wake(0.5, &mut drains).steps, 0);
        // Clamped rather than subtracted: an NTP correction arrives as a reading behind the last
        // one, and a negative delta would rewind the accumulator.
        assert_eq!(clock.now_seconds(), 0.5);
    }

    #[test]
    fn discards_a_non_finite_reading_rather_than_storing_it() {
        let mut clock = Clock::new(60.0, 20.0);
        let mut drains = Vec::new();
        clock.wake(0.0, &mut drains);
        clock.wake(f64::NAN, &mut drains);
        assert_eq!(clock.wake(3.0 / 60.0, &mut drains).steps, 3);
    }

    #[test]
    fn caps_one_wake_and_sheds_the_backlog_it_could_not_reach() {
        let mut clock = Clock::new(60.0, 20.0);
        let mut drains = Vec::new();
        clock.wake(0.0, &mut drains);
        let out = clock.wake(5.0, &mut drains);
        assert_eq!(out.steps, max_steps_per_wake(60.0));
        assert!(out.shed);
        assert_eq!(clock.shed_count(), 1);
        assert_eq!(clock.accumulator, 0.0);
    }

    #[test]
    fn keeps_a_legitimate_remainder_when_the_cap_was_hit_but_the_backlog_drained() {
        let mut clock = Clock::new(60.0, 20.0);
        let mut drains = Vec::new();
        clock.wake(0.0, &mut drains);
        let cap = max_steps_per_wake(60.0);
        let out = clock.wake(f64::from(cap) / 60.0, &mut drains);
        assert_eq!(out.steps, cap);
        assert!(!out.shed);
        assert_eq!(clock.shed_count(), 0);
    }

    #[test]
    fn fires_one_broadcast_per_sim_over_send_steps() {
        let mut clock = Clock::new(60.0, 20.0);
        let mut drains = Vec::new();
        assert_eq!(ticks_per_send(60.0, 20.0), 3);
        clock.wake(0.0, &mut drains);
        let out = clock.wake(3.0 / 60.0, &mut drains);
        assert_eq!(out.sends, 1);
        assert_eq!(drains, vec![false, false, true]);
    }

    #[test]
    fn counts_the_cadence_here_rather_than_off_the_tick_index() {
        let mut clock = Clock::new(60.0, 20.0);
        let mut drains = Vec::new();
        clock.wake(0.0, &mut drains);
        // Two wakes of two ticks each: the send lands on the third TICK, which falls inside the
        // second wake — a boundary a cadence derived from the tick index could not see.
        assert_eq!(clock.wake(2.0 / 60.0, &mut drains).sends, 0);
        assert_eq!(clock.wake(4.0 / 60.0, &mut drains).sends, 1);
        assert_eq!(drains, vec![true, false]);
    }
}
