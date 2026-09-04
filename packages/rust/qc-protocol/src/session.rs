//! Endpoint-independent USB session policy shared by native hosts.
//!
//! OS adapters still open handles and perform reads/writes. This module owns
//! reconnect cadence, handshake attempts, report-id probing, idle keepalives,
//! synchronization readiness, and link-loss tolerance so those decisions do
//! not drift between Android and Windows.

use crate::framing::{self, FrameError};
use crate::profile;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPhase {
    Disconnected,
    Searching,
    Handshaking,
    Syncing,
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandshakeAttempt {
    pub number: u32,
    pub include_report_id: bool,
}

#[derive(Debug, Clone)]
pub struct SessionMachine {
    phase: SessionPhase,
    auto_reconnect: bool,
    next_reconnect_at_ms: u64,
    handshake_started_at_ms: Option<u64>,
    handshake_attempts: u32,
    next_handshake_at_ms: u64,
    next_keepalive_at_ms: u64,
    consecutive_read_errors: u8,
    synchronized: bool,
}

impl SessionMachine {
    pub fn new(now_ms: u64) -> Self {
        Self {
            phase: SessionPhase::Searching,
            auto_reconnect: true,
            next_reconnect_at_ms: now_ms,
            handshake_started_at_ms: None,
            handshake_attempts: 0,
            next_handshake_at_ms: now_ms,
            next_keepalive_at_ms: now_ms.saturating_add(profile::KEEPALIVE_INTERVAL_MS),
            consecutive_read_errors: 0,
            synchronized: false,
        }
    }

    pub fn phase(&self) -> SessionPhase {
        self.phase
    }
    pub fn synchronized(&self) -> bool {
        self.synchronized
    }
    pub fn is_connected(&self) -> bool {
        matches!(self.phase, SessionPhase::Syncing | SessionPhase::Ready)
    }

    pub fn request_reconnect(&mut self, now_ms: u64) {
        self.auto_reconnect = true;
        self.phase = SessionPhase::Searching;
        self.next_reconnect_at_ms = now_ms;
        self.reset_connection_state(now_ms);
    }

    pub fn disconnect(&mut self, now_ms: u64, recover: bool) {
        self.auto_reconnect = recover;
        self.phase = if recover {
            SessionPhase::Searching
        } else {
            SessionPhase::Disconnected
        };
        self.next_reconnect_at_ms = now_ms.saturating_add(profile::RECONNECT_INTERVAL_MS);
        self.reset_connection_state(now_ms);
    }

    pub fn reconnect_due(&self, now_ms: u64) -> bool {
        self.auto_reconnect
            && self.phase == SessionPhase::Searching
            && now_ms >= self.next_reconnect_at_ms
    }

    pub fn reconnect_attempted(&mut self, now_ms: u64) {
        self.next_reconnect_at_ms = now_ms.saturating_add(profile::RECONNECT_INTERVAL_MS);
    }

    pub fn transport_opened(&mut self, now_ms: u64) {
        self.phase = SessionPhase::Handshaking;
        self.handshake_started_at_ms = Some(now_ms);
        self.handshake_attempts = 0;
        self.next_handshake_at_ms = now_ms;
        self.synchronized = false;
        self.consecutive_read_errors = 0;
        self.outbound(now_ms);
    }

    /// Returns the next standards/body-only HID probe. Calling this reserves
    /// one attempt until its timeout, so tight polling cannot duplicate writes.
    pub fn next_handshake_attempt(&mut self, now_ms: u64) -> Option<HandshakeAttempt> {
        if self.phase != SessionPhase::Handshaking || now_ms < self.next_handshake_at_ms {
            return None;
        }
        if self.handshake_timed_out(now_ms) {
            return None;
        }
        self.handshake_attempts += 1;
        self.next_handshake_at_ms = now_ms.saturating_add(profile::HANDSHAKE_ATTEMPT_TIMEOUT_MS);
        self.outbound(now_ms);
        Some(HandshakeAttempt {
            number: self.handshake_attempts,
            include_report_id: self.handshake_attempts % 2 == 1,
        })
    }

    pub fn handshake_timed_out(&self, now_ms: u64) -> bool {
        self.phase == SessionPhase::Handshaking
            && self.handshake_started_at_ms.is_some_and(|started| {
                now_ms.saturating_sub(started) >= profile::HANDSHAKE_TIMEOUT_MS
            })
    }

    /// True while a sent reset request still owns the handshake reply window.
    pub fn awaiting_handshake_reply(&self, now_ms: u64) -> bool {
        self.phase == SessionPhase::Handshaking
            && now_ms < self.next_handshake_at_ms
            && !self.handshake_timed_out(now_ms)
    }

    pub fn handshake_completed(&mut self, now_ms: u64, synchronized: bool) {
        self.phase = if synchronized {
            SessionPhase::Ready
        } else {
            SessionPhase::Syncing
        };
        self.synchronized = synchronized;
        self.consecutive_read_errors = 0;
        self.outbound(now_ms);
    }

    pub fn state_observed(&mut self, now_ms: u64, preset_synchronized: bool) {
        self.consecutive_read_errors = 0;
        if preset_synchronized && self.is_connected() {
            self.synchronized = true;
            self.phase = SessionPhase::Ready;
        }
        self.next_keepalive_at_ms = now_ms.saturating_add(profile::KEEPALIVE_INTERVAL_MS);
    }

    pub fn outbound(&mut self, now_ms: u64) {
        self.next_keepalive_at_ms = now_ms.saturating_add(profile::KEEPALIVE_INTERVAL_MS);
    }

    pub fn keepalive_due(&self, now_ms: u64) -> bool {
        self.is_connected() && now_ms >= self.next_keepalive_at_ms
    }

    pub fn read_succeeded(&mut self) {
        self.consecutive_read_errors = 0;
    }

    /// A single native read error is tolerated because both host USB stacks
    /// occasionally surface transient status-stage failures.
    pub fn read_failed(&mut self) -> bool {
        self.consecutive_read_errors = self.consecutive_read_errors.saturating_add(1);
        self.consecutive_read_errors >= 2
    }

    fn reset_connection_state(&mut self, now_ms: u64) {
        self.handshake_started_at_ms = None;
        self.handshake_attempts = 0;
        self.next_handshake_at_ms = now_ms;
        self.next_keepalive_at_ms = now_ms.saturating_add(profile::KEEPALIVE_INTERVAL_MS);
        self.consecutive_read_errors = 0;
        self.synchronized = false;
    }
}

#[derive(Debug, Default)]
pub struct FrameAssembler {
    reports: Vec<Vec<u8>>,
}

impl FrameAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.reports.clear();
    }

    pub fn push(&mut self, report: Vec<u8>) -> Result<Option<(u16, Vec<u8>)>, FrameError> {
        if report.len() < 3 {
            self.reset();
            return Ok(None);
        }
        let is_first = report[2] & framing::FLAG_FIRST != 0;
        if is_first {
            self.reset();
        } else if self.reports.is_empty() {
            // HID is a live stream. A host can attach between chunks, or the
            // device can leave one trailing continuation queued after a reset.
            // Ignore orphan continuations until the next FIRST report instead
            // of poisoning the whole USB session with MissingFirst.
            return Ok(None);
        }
        self.reports.push(report);
        if self.reports.len() > profile::MAX_FRAME_BYTES / framing::CHUNK_SIZE + 1 {
            self.reset();
            return Err(FrameError::TooLarge);
        }
        if !framing::is_complete(&self.reports)? {
            return Ok(None);
        }
        let reports = std::mem::take(&mut self.reports);
        framing::decode(&reports).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assembles_complete_frames_and_recovers_from_short_reports() {
        let payload = vec![0x5a; framing::CHUNK_SIZE * 2];
        let reports = framing::encode(51, &payload);
        let mut assembler = FrameAssembler::new();
        assert_eq!(assembler.push(vec![1, 2]).unwrap(), None);
        for report in reports.iter().take(reports.len() - 1) {
            assert_eq!(assembler.push(report.to_vec()).unwrap(), None);
        }
        assert_eq!(
            assembler.push(reports.last().unwrap().to_vec()).unwrap(),
            Some((51, payload))
        );
    }

    #[test]
    fn a_new_first_report_discards_an_abandoned_frame() {
        let incomplete = framing::encode(51, &vec![1; framing::CHUNK_SIZE * 2]);
        let complete = framing::encode(13, &[8, 1, 24, 2]);
        let mut assembler = FrameAssembler::new();
        assert_eq!(assembler.push(incomplete[0].to_vec()).unwrap(), None);
        assert_eq!(
            assembler.push(complete[0].to_vec()).unwrap(),
            Some((13, vec![8, 1, 24, 2]))
        );
    }

    #[test]
    fn orphan_continuations_are_ignored_until_the_next_first_report() {
        let mut assembler = FrameAssembler::new();
        let mut orphan = framing::encode(51, &vec![1; framing::CHUNK_SIZE * 2])[1].to_vec();
        orphan[2] |= framing::FLAG_LAST;
        assert_eq!(assembler.push(orphan).unwrap(), None);

        let complete = framing::encode(13, &[8, 1, 24, 2]);
        assert_eq!(
            assembler.push(complete[0].to_vec()).unwrap(),
            Some((13, vec![8, 1, 24, 2]))
        );
    }

    #[test]
    fn session_policy_alternates_android_hid_forms_and_times_out_once() {
        let mut session = SessionMachine::new(0);
        assert!(session.reconnect_due(0));
        session.transport_opened(10);
        assert!(
            session
                .next_handshake_attempt(10)
                .unwrap()
                .include_report_id
        );
        assert!(session.next_handshake_attempt(11).is_none());
        assert!(
            !session
                .next_handshake_attempt(10 + profile::HANDSHAKE_ATTEMPT_TIMEOUT_MS)
                .unwrap()
                .include_report_id
        );
        assert!(session.handshake_timed_out(10 + profile::HANDSHAKE_TIMEOUT_MS));
    }

    #[test]
    fn session_policy_keeps_only_idle_ready_links_alive() {
        let mut session = SessionMachine::new(0);
        session.transport_opened(0);
        session.handshake_completed(100, false);
        assert_eq!(session.phase(), SessionPhase::Syncing);
        session.state_observed(200, true);
        assert_eq!(session.phase(), SessionPhase::Ready);
        assert!(!session.keepalive_due(200 + profile::KEEPALIVE_INTERVAL_MS - 1));
        assert!(session.keepalive_due(200 + profile::KEEPALIVE_INTERVAL_MS));
        session.outbound(3000);
        assert!(!session.keepalive_due(3001));
    }

    #[test]
    fn session_policy_tolerates_one_read_error_and_recovers() {
        let mut session = SessionMachine::new(0);
        session.transport_opened(0);
        session.handshake_completed(1, true);
        assert!(!session.read_failed());
        session.read_succeeded();
        assert!(!session.read_failed());
        assert!(session.read_failed());
        session.disconnect(100, true);
        assert!(!session.reconnect_due(100));
        assert!(session.reconnect_due(100 + profile::RECONNECT_INTERVAL_MS));
    }
}
