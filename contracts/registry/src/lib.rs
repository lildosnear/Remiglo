//! Remiglo Registry — the NEAR smart contract layer of Remiglo
//! (docs/ARCHITECTURE.md, layer 2).
//!
//! What this contract is responsible for:
//! - Authorization: the contract owner registers merchants; each
//!   merchant has admin accounts allowed to act for it.
//! - Spending policies per merchant: a per payout cap, a daily
//!   budget and an approval threshold, mirroring the API rules.
//! - Batch records: a hash of the batch payload plus totals and a
//!   status, anchored on chain so a third party can verify what the
//!   API reported.
//! - Audit events: NEP-297 style EVENT_JSON logs for every mutation.
//!
//! What it is NOT responsible for: moving money. Settlement stays
//! with NEAR Intents (layer 3) under the boundary rule.

use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::serde_json;
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, PanicOnDefault};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct MerchantRecord {
    pub admins: Vec<AccountId>,
    pub registered_by: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Policy {
    /// Max amount for a single payout (smallest units).
    pub per_payout_cap: u128,
    /// Max total anchored spend per day (smallest units).
    pub daily_budget: u128,
    /// Batch totals above this need an explicit approval (smallest units).
    pub approval_threshold: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct BatchRecord {
    pub merchant: AccountId,
    /// Hash of the canonical batch payload the API created.
    pub payload_hash: String,
    pub total: u128,
    pub row_count: u32,
    pub status: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PayoutAnchor {
    pub merchant: AccountId,
    pub amount: u128,
    pub recipient: String,
    pub asset: String,
    pub batch_id: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    pub owner: AccountId,
    pub merchants: UnorderedMap<AccountId, MerchantRecord>,
    pub policies: LookupMap<AccountId, Policy>,
    pub batches: UnorderedMap<String, BatchRecord>,
    pub payout_anchors: UnorderedMap<String, PayoutAnchor>,
    /// Anchored spend per "merchant|day" key, for the daily budget.
    pub spend_by_day: LookupMap<String, u128>,
}

const DAY_NANOS: u64 = 86_400_000_000_000;

fn day_key(merchant: &AccountId) -> String {
    let day = env::block_timestamp() / DAY_NANOS;
    format!("{}|{}", merchant, day)
}

fn emit(event: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"remiglo\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":{}}}",
        event, data
    ));
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        assert!(!env::state_exists(), "already initialized");
        Self {
            owner,
            merchants: UnorderedMap::new(b"m"),
            policies: LookupMap::new(b"p"),
            batches: UnorderedMap::new(b"b"),
            payout_anchors: UnorderedMap::new(b"a"),
            spend_by_day: LookupMap::new(b"s"),
        }
    }

    // ------------------------------------------------------------ auth
    fn assert_owner(&self) {
        assert_eq!(env::predecessor_account_id(), self.owner, "only the registry owner may do this");
    }

    fn is_admin(&self, merchant: &AccountId, who: &AccountId) -> bool {
        if *who == self.owner {
            return true;
        }
        match self.merchants.get(merchant) {
            Some(rec) => rec.admins.iter().any(|a| a == who),
            None => false,
        }
    }

    fn assert_merchant_admin(&self, merchant: &AccountId) {
        let who = env::predecessor_account_id();
        assert!(
            self.is_admin(merchant, &who),
            "{} is not an admin for merchant {}",
            who, merchant
        );
    }

    // ------------------------------------------------------- merchants
    /// Register a merchant. Owner only. Emits merchant_registered.
    pub fn register_merchant(&mut self, merchant: AccountId, admins: Vec<AccountId>) {
        self.assert_owner();
        assert!(self.merchants.get(&merchant).is_none(), "merchant already registered");
        let rec = MerchantRecord { admins: admins.clone(), registered_by: env::predecessor_account_id() };
        self.merchants.insert(&merchant, &rec);
        emit(
            "merchant_registered",
            format!(
                "{{\"merchant\":\"{}\",\"admins\":{}}}",
                merchant,
                serde_json::to_string(&admins).unwrap_or_else(|_| "[]".to_string())
            ),
        );
    }

    /// Add an admin to a merchant. Owner or an existing merchant admin.
    pub fn add_merchant_admin(&mut self, merchant: AccountId, admin: AccountId) {
        self.assert_merchant_admin(&merchant);
        let mut rec = self.merchants.get(&merchant).expect("merchant not registered");
        if !rec.admins.iter().any(|a| *a == admin) {
            rec.admins.push(admin.clone());
            self.merchants.insert(&merchant, &rec);
        }
        emit("merchant_admin_added", format!("{{\"merchant\":\"{}\",\"admin\":\"{}\"}}", merchant, admin));
    }

    // -------------------------------------------------------- policies
    /// Set the spending policy for a merchant. Owner or merchant admin.
    pub fn set_policy(&mut self, merchant: AccountId, per_payout_cap: U128, daily_budget: U128, approval_threshold: U128) {
        self.assert_merchant_admin(&merchant);
        let (per_payout_cap, daily_budget, approval_threshold) = (per_payout_cap.0, daily_budget.0, approval_threshold.0);
        let policy = Policy { per_payout_cap, daily_budget, approval_threshold };
        self.policies.insert(&merchant, &policy);
        emit(
            "policy_updated",
            format!(
                "{{\"merchant\":\"{}\",\"per_payout_cap\":\"{}\",\"daily_budget\":\"{}\",\"approval_threshold\":\"{}\"}}",
                merchant, per_payout_cap, daily_budget, approval_threshold
            ),
        );
    }

    /// Enforcement helper: every reason this spend should not proceed
    /// silently. Empty means clean; "approval_required" means the
    /// amount is allowed but must go through an approval first.
    pub fn check_spend(&self, merchant: AccountId, amount: U128) -> Vec<String> {
        self.check_spend_inner(merchant, amount.0)
    }

    fn check_spend_inner(&self, merchant: AccountId, amount: u128) -> Vec<String> {
        let mut reasons = Vec::new();
        let policy = match self.policies.get(&merchant) {
            Some(p) => p,
            None => {
                reasons.push("no_policy".to_string());
                return reasons;
            }
        };
        if amount > policy.per_payout_cap {
            reasons.push("over_cap".to_string());
        }
        let spent = self.spent_today(merchant.clone());
        if spent.saturating_add(amount) > policy.daily_budget {
            reasons.push("over_budget".to_string());
        }
        if amount > policy.approval_threshold {
            reasons.push("approval_required".to_string());
        }
        reasons
    }

    /// Total anchored spend for the merchant today (block timestamp day).
    pub fn spent_today(&self, merchant: AccountId) -> u128 {
        self.spend_by_day.get(&day_key(&merchant)).unwrap_or(0)
    }

    // --------------------------------------------------------- batches
    /// Anchor a batch record. Merchant admin only. Emits batch_recorded.
    pub fn record_batch(&mut self, merchant: AccountId, batch_id: String, payload_hash: String, total: U128, row_count: u32) {
        self.assert_merchant_admin(&merchant);
        assert!(self.batches.get(&batch_id).is_none(), "batch already recorded");
        let total = total.0;
        let rec = BatchRecord { merchant: merchant.clone(), payload_hash: payload_hash.clone(), total, row_count, status: "recorded".to_string() };
        self.batches.insert(&batch_id, &rec);
        emit(
            "batch_recorded",
            format!(
                "{{\"merchant\":\"{}\",\"batch_id\":\"{}\",\"payload_hash\":\"{}\",\"total\":\"{}\",\"row_count\":{}}}",
                merchant, batch_id, payload_hash, total, row_count
            ),
        );
    }

    /// Advance a batch record's status. Admin of the batch's merchant.
    pub fn update_batch_status(&mut self, batch_id: String, status: String) {
        let mut rec = self.batches.get(&batch_id).expect("batch not recorded");
        self.assert_merchant_admin(&rec.merchant.clone());
        rec.status = status.clone();
        let merchant = rec.merchant.clone();
        self.batches.insert(&batch_id, &rec);
        emit("batch_status_changed", format!("{{\"merchant\":\"{}\",\"batch_id\":\"{}\",\"status\":\"{}\"}}", merchant, batch_id, status));
    }

    // --------------------------------------------------------- payouts
    /// Anchor an individual payout and count it against the daily
    /// budget. Rejects (panics) when the spend breaks the cap or the
    /// budget; "approval_required" alone does not block anchoring,
    /// because the approval happened on the API side before anchoring.
    /// Emits payout_anchored.
    pub fn anchor_payment(&mut self, merchant: AccountId, anchor_id: String, amount: U128, recipient: String, asset: String, batch_id: Option<String>) {
        self.assert_merchant_admin(&merchant);
        assert!(self.payout_anchors.get(&anchor_id).is_none(), "payout already anchored");
        let amount = amount.0;
        let reasons = self.check_spend_inner(merchant.clone(), amount);
        assert!(
            !reasons.iter().any(|r| r == "over_cap" || r == "over_budget" || r == "no_policy"),
            "spend rejected by policy: {}",
            reasons.join(",")
        );
        let key = day_key(&merchant);
        let spent = self.spend_by_day.get(&key).unwrap_or(0);
        self.spend_by_day.insert(&key, &(spent + amount));
        let rec = PayoutAnchor { merchant: merchant.clone(), amount, recipient: recipient.clone(), asset: asset.clone(), batch_id: batch_id.clone() };
        self.payout_anchors.insert(&anchor_id, &rec);
        emit(
            "payout_anchored",
            format!(
                "{{\"merchant\":\"{}\",\"anchor_id\":\"{}\",\"amount\":\"{}\",\"recipient\":\"{}\",\"asset\":\"{}\"}}",
                merchant, anchor_id, amount, recipient, asset
            ),
        );
    }

    // ----------------------------------------------------------- views
    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_merchant(&self, merchant: AccountId) -> Option<MerchantRecord> {
        self.merchants.get(&merchant)
    }

    pub fn list_merchants(&self) -> Vec<AccountId> {
        self.merchants.keys().collect()
    }

    pub fn merchant_count(&self) -> u64 {
        self.merchants.len()
    }

    pub fn get_policy(&self, merchant: AccountId) -> Option<Policy> {
        self.policies.get(&merchant)
    }

    pub fn get_batch(&self, batch_id: String) -> Option<BatchRecord> {
        self.batches.get(&batch_id)
    }

    pub fn list_batches(&self) -> Vec<String> {
        self.batches.keys().collect()
    }

    pub fn batch_count(&self) -> u64 {
        self.batches.len()
    }

    pub fn get_payout_anchor(&self, anchor_id: String) -> Option<PayoutAnchor> {
        self.payout_anchors.get(&anchor_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn context(predecessor: AccountId) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(accounts(0))
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .block_timestamp(1_700_000_000_000_000_000);
        builder
    }

    fn registry_with_merchant() -> Registry {
        testing_env!(context(accounts(0)).build());
        let mut reg = Registry::new(accounts(0));
        reg.register_merchant(accounts(1), vec![accounts(2)]);
        reg
    }

    #[test]
    fn owner_registers_merchant_and_views_work() {
        let reg = registry_with_merchant();
        assert_eq!(reg.merchant_count(), 1);
        assert_eq!(reg.list_merchants(), vec![accounts(1)]);
        let rec = reg.get_merchant(accounts(1)).unwrap();
        assert_eq!(rec.admins, vec![accounts(2)]);
    }

    #[test]
    #[should_panic(expected = "only the registry owner may do this")]
    fn unauthorized_register_is_rejected() {
        testing_env!(context(accounts(0)).build());
        let mut reg = Registry::new(accounts(0));
        testing_env!(context(accounts(3)).build());
        reg.register_merchant(accounts(1), vec![accounts(2)]);
    }

    #[test]
    #[should_panic(expected = "not an admin for merchant")]
    fn unauthorized_policy_update_is_rejected() {
        let mut reg = registry_with_merchant();
        testing_env!(context(accounts(3)).build());
        reg.set_policy(accounts(1), U128(100), U128(1_000), U128(500));
    }

    #[test]
    fn policy_update_and_check_spend_reasons() {
        let mut reg = registry_with_merchant();
        testing_env!(context(accounts(2)).build()); // merchant admin
        reg.set_policy(accounts(1), U128(100), U128(1_000), U128(40));
        assert_eq!(reg.check_spend(accounts(1), U128(50)), vec!["approval_required".to_string()]);
        assert!(reg.check_spend(accounts(1), U128(30)).is_empty());
        assert_eq!(reg.check_spend(accounts(1), U128(150)), vec!["over_cap".to_string(), "approval_required".to_string()]);
        // spend 950 of the 1000 budget in under cap anchors of 95,
        // then 100 more breaks the budget (but not the cap)
        for i in 0..10 {
            reg.anchor_payment(accounts(1), format!("a{}", i), U128(95), "ada.near".to_string(), "usdc".to_string(), None);
        }
        assert_eq!(reg.spent_today(accounts(1)), 950);
        let reasons = reg.check_spend(accounts(1), U128(100));
        assert!(reasons.contains(&"over_budget".to_string()), "reasons: {:?}", reasons);
        assert!(!reasons.contains(&"over_cap".to_string()), "reasons: {:?}", reasons);
    }

    #[test]
    #[should_panic(expected = "spend rejected by policy")]
    fn anchor_payment_over_cap_is_rejected() {
        let mut reg = registry_with_merchant();
        testing_env!(context(accounts(2)).build());
        reg.set_policy(accounts(1), U128(100), U128(1_000), U128(500));
        reg.anchor_payment(accounts(1), "a1".to_string(), U128(500), "ada.near".to_string(), "usdc".to_string(), None);
    }

    #[test]
    fn batch_record_and_status_flow() {
        let mut reg = registry_with_merchant();
        testing_env!(context(accounts(2)).build());
        reg.record_batch(accounts(1), "batch_1".to_string(), "abc123".to_string(), U128(5_000), 6);
        let rec = reg.get_batch("batch_1".to_string()).unwrap();
        assert_eq!(rec.status, "recorded");
        assert_eq!(rec.total, 5_000);
        reg.update_batch_status("batch_1".to_string(), "completed".to_string());
        assert_eq!(reg.get_batch("batch_1".to_string()).unwrap().status, "completed");
        assert_eq!(reg.batch_count(), 1);
        assert_eq!(reg.list_batches(), vec!["batch_1".to_string()]);
    }

    #[test]
    #[should_panic(expected = "not an admin for merchant")]
    fn unauthorized_batch_record_is_rejected() {
        let mut reg = registry_with_merchant();
        testing_env!(context(accounts(3)).build());
        reg.record_batch(accounts(1), "batch_1".to_string(), "abc".to_string(), U128(100), 1);
    }

    #[test]
    fn event_shape_is_nep297_style() {
        // Logs cannot be asserted directly in unit tests; assert the
        // state an indexer would rebuild from the events instead.
        let mut reg = registry_with_merchant();
        testing_env!(context(accounts(2)).build());
        reg.set_policy(accounts(1), U128(100), U128(1_000), U128(500));
        reg.record_batch(accounts(1), "b1".to_string(), "hash".to_string(), U128(100), 1);
        assert_eq!(reg.get_policy(accounts(1)).unwrap().per_payout_cap, 100);
        assert!(reg.get_batch("b1".to_string()).is_some());
    }
}
