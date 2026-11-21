# Phase 7 spike: proportional collateral release under a hidden installment

Feasibility note for the spec. Written 2026-11-21 against `v2/main` at 552aab6, in two parts: a
first pass, and a second pass that measured route C on regtest and prototyped the liquidation
repair. After reading it the user postponed phase 7 again (2026-11-21). The throwaway prototypes are
kept beside this note (`proto/`, `regtest/`, `bsgs/`), outside the workspace's build; paths in the
text that name `p7-spike/` refer to this directory.

Every figure is marked **measured** (run here), **counted** (jet prices times operations) or
**estimate**. The budget rule applied throughout is the one Liquid relays: a program's cost must be
paid by its own witness stack, `cost ≤ 1000 × (stack bytes + 50)` mWU. Annex padding is not
relayed (non-standard while Elements PR 1539 is open; the user's bulletproofs fork,
`docs/simplicity-verifier.md`).

## Verdict

**Buildable, with route C and the liquidation repair.**

- **Route C, measured on regtest.**
  - **The installment:**
    - It releases collateral by `c' = ceil(d'·C/R)`. A Sigma proof checks it, linked to two
      carry outputs of a worthless token, with the repair's blinder commitment.
    - In the steady state it confirms at **42,479 WU**.
    - The loan input costs 3,841,336 mWU against its own budget of 7,417,000 mWU, with no padding.
    - The first installment had a carry `e' = 0`, which confirmed. The carries hold `e' + 1` and
      `R − e'` on a pinned spendable script, so a zero carry needs no special case.
  - **Refused by the program (six cases):**
    - two on the release rule: a successor holding `c' + 1`, and carries split one unit wrong;
    - four on the repair: a random successor blinder against the honest `Y`, a self-made `Y`
      with the honest path, the index of `i + 1` at step `i`, and the leaf of `i + 1` at step `i`.
    - None of them was broadcast; consensus runs the same program.
  - **Against today:** the spike omits the borrower NFT's input and output, so the real
    installment would be about 43,000 WU (estimate). Today's is 24,794 WU (measured), so a release
    adds about 18,200 WU, or about 455 sats at 0.1 sat/vB.
- **The repair works on regtest.** The lender read neither installment, and still:
  - recovered the released collateral's opening with a baby-step giant-step search;
  - built a liquidation that spends it, and the liquidation confirmed.
- **The search:**
  - For C < 2^40 it takes 6.5 s native and 9.4 s in wasm (node), using 45 MiB.
  - For C < 2^44 it takes 25.8 s native and 38.2 s in wasm, using 138 MiB.
  - All measured on an Apple M4 Pro. A slower machine will take longer.
- **Route S** (in-program bit range proofs) needs about 1.6 kB of padding as measured. Annex
  padding is not relayed, so as measured it is **not usable**. Restructured to pay for itself, it
  comes to about 64,000 WU (estimate).
- **BP++ from the user's fork, with the same Sigma link:**
  - It would remove the carry token and its two extra outputs.
  - The installment would be about 49,000 WU if a reciprocal range proof weighs like the fork's
    32-gate chain. It would be about 86,000 WU (77,000 at 52 bits) with 128 bit-constraint gates.
    Both are estimates; the gate count is unverified (section 5).
  - The verifier is the fork's compiler output, which is unaudited.
- **Baseline without proofs:** a release the lender co-signs comes to about 29,700 WU (estimate).
  It depends on the lender's cooperation for each release.

**Recommendation.** Build route C with the repair, under these conditions:

- The lender enforces `C < 2^40` at acceptance, or `2^44` if a 40-second wait at liquidation is
  acceptable.
- The soundness proofs of section 7 are written before release.
- Before building, measure the fork's reciprocal range circuit. If it comes to about 49,000 WU,
  it is the simpler deployment: no carry token, at about 6,000 WU more per installment.
- Keep the co-signed release as the fallback if the proofs are not accepted.

## 1. The statement

### Notation

The notation is the Phase 5 design note's:

- `A` is the repayment asset commitment, and `D = d·A + r·G` is the debt.
- `D₀ = R·A + r₀·G` is the starting debt.
- `A_c` and `V_c0 = C·A_c + ρ·G` are the active collateral's asset and value commitments at
  acceptance.
- After installment `i`, the loan output's asset commitment is `A_c + i·G`.

### The rule, stateless form

After an installment, the debt left is `D' = D − V_p`, which the program computes today. The
successor's collateral amount must then be:

```
c' = ceil(d'·C / R)          equivalently   e' := c'·R − d'·C  satisfies  0 ≤ e' < R
```

This is the brief's formula. With `paid' = R − d'`:

```
C − floor(paid'·C/R) = C − floor(C − d'·C/R) = ceil(d'·C/R)
```

The releases therefore add up to `floor(paid·C/R)` at every step. They add up to `C` at the full
repayment, which releases whatever is left.

The brief's carry route stores `e = paid·C mod R`. The stateless form recomputes
`e' = c'·R − d'·C` from `D'` and the successor each time instead, so it needs no storage slot.

- It never refers to the release `q` or to a release output: Elements' value conservation sends
  `c_in − c'` wherever the borrower likes.
- **q = 0 needs no special case.** An installment too small to release anything leaves
  `c' = c_in`.
- On regtest, both installments released exactly `floor(paid·C/R) − floor(paid_prev·C/R)`.

### Bounds and where they come from

| Value | Source | Bound and why |
|---|---|---|
| `D'` | computed `D − V`; `D` authenticated by storage `h(A, D)` | `d' = R − Σp_i` over integers |
| `p_i` | installment output (introspection, pinned script) | `[1, 2^64)`: consensus |
| `c'` | successor's value commitment `V_s` (introspection) | `[1, 2^64)`: consensus |
| `C` | inside `V_c0` (parameter, point form) | `[1, 2^64)`: consensus, at acceptance |
| `R` | inside `D₀` (parameter, point form) | `[1, 2^64)`: the lender checks it |
| `e' + 1`, `R − e'` | carries `W1`, `W2` on `CARRY_SCRIPT_HASH` (route C) | `[1, 2^64)` |

Sources for the consensus bounds:

- `secp256k1_rangeproof_getheader_impl` rejects `max_value > UINT64_MAX`
  (`secp256k1-zkp-sys-0.10.1/.../rangeproof_impl.h`, lines 486–534).
- `CachingRangeProofChecker::VerifyRangeProof` rejects `min_value == 0` only for spendable scripts
  ([sigcache.cpp][sigcache]).

So the program pins the carries to `CARRY_SCRIPT_HASH`, a spendable script of the borrower's,
which the lender checks at acceptance. That gives `e' + 1 ≥ 1` and `R − e' ≥ 1`, so
`0 ≤ e' ≤ R − 1`, and a carry is never 0. The script must be spendable: not an `OP_RETURN`, and
within the size limit.

### The proof (route C, as run on regtest)

The secrets are `C, ρ, c', x, y, e, w1, R, r₀, w2, τ`. Equal responses tie each secret across the
equations it appears in:

```
E1  V_c0      = C·A_c + ρ·G
E2  V_s       = c'·A_c + x·G           (V_s = c'·(A_c + (i+1)G) + r_s·G, so x = c'(i+1) + r_s)
E3  Y_(i+1)   = x·G + y·J              (the repair: x is the committed blinder x_(i+1))
E4  W1 − A_w1 = e·A_w1 + w1·G          (carry 1 holds e' + 1)
E5  D₀        = R·A + r₀·G
E6  W2        = (R − e)·A_w2 + w2·G    (carry 2 holds R − e')
E7  0         = c'·D₀ − C·D' − e·A − τ·G
```

- **Integer soundness.** Extraction gives `c'R − d'C − e' ≡ 0 (mod n)`.
  - The terms are below `2^128`, and `(k+1)·2^128` after `k` installments, so the relation holds
    over the integers.
  - With `0 ≤ e' ≤ R − 1`, it forces `c' = ceil(d'C/R)`.
  - This needs the discrete logarithms of `A`, `A_c`, `A_w1`, `A_w2` and `J` to `G` to be unknown.
    Surjection proofs and NUMS generators give that, even if the assets coincide.
- **Overpayment and zero debt become unreachable.**
  - `d' ≤ 0` forces `c' < 1`, which no spendable successor can hold.
  - The zero-debt close branch becomes dead code.
  - The phase 5 liveness test's "exact remaining debt with another blinder" case must now expect
    the installment to fail.
- **Fiat–Shamir.**
  - The challenge chains `sha_256_block` from `FS_IV`, a SHA-256 of the constants `A, A_c, V_c0,
    D₀, J`.
  - It absorbs `D', V_s, W1, A_w1, W2, A_w2, Y`, then `T1..T7`: one compression per point
    (`x ‖ y`).
- **New parameters:**
  - Points `A`, `A_c`, `V_c0`, `D₀` and `J`, plus `Y_ROOT` and the hash IVs.
  - The lender checks them at acceptance, with the rest of the address.
  - They must match `REPAYMENT_COMMITMENT` and `ACTIVE_COLLATERAL_COMMITMENT`.

## 2. The liquidation problem and its repair

After a release the loan output holds `c' = ceil(d'C/R)`, and its blinder is the borrower's
choice. The lender knows `d'` only if it can open every installment, and phase 5 admits that it may
not.

So without a repair, one unreadable installment leaves a loan the lender cannot liquidate. Spending
a confidential input needs its amount and blinder. This is step 6's first failure, and it applies
to every route.

### Ways around it that fail

Each of these runs into a test that anyone can do with only public data:

- **A public blinder point.** A rule checked with a public `x·G` lets anyone search `V_s − X =
  c'·A_c` over `c' ≤ C`.
- **Linearly stepped blinders.** They expose differences of amounts to the same search.
- **Verifiably encrypting a 256-bit blinder.** It costs about 62,000,000 mWU (counted).

### The repair (prototyped and run on regtest)

**At acceptance**, both parties derive the blinders `x_i` and `y_i` for `i = 1..N` from their
shared secret. The spike uses `N = 1024`.

- The program carries the Merkle root `Y_ROOT` over the leaves
  `sha_256_block(LEAF_IV, Y_i.x, Y_i.y)`.
- Each leaf commits to `Y_i = x_i·G + y_i·J`, and the nodes are
  `sha_256_block(NODE_IV, left, right)`.

**At installment `i+1`** the witness carries `i` (a `u16`), `Y_(i+1)` and its 10-level path. The
program checks three things:

- The input's asset commitment is `A_c + i·G` (`generate(i)`, `gej_ge_add`, then a comparison of
  encodings).
- The path leads from `Y_(i+1)` at leaf `i` to `Y_ROOT`.
- E2 and E3 hold with the same `x`.

**At liquidation**, the lender has:

- `C`, the collateral's asset blinder at acceptance `a_c`, and the `x_i`;
- the number of installments `i`, read from the chain;
- the debt as a point, `D₀ − ΣV_k` over the installment outputs. It opens none of them.

From these it recovers the successor's opening:

- It computes `V_s − x_i·G = c'·A_c` and finds `c' ∈ [1, C]` by baby-step giant-step.
- The successor's asset blinder is `a_c + i`, and its value blinder is `x_i − c'·i`.

On regtest the lender did exactly this after two installments sent to a blinding key it did not
have. It found `c' = 366,174,657,819` and liquidated; the transaction confirmed at 10,500 WU.

The spike's liquidation branch is a stand-in that checks nothing. The real branch reads neither the
debt's opening nor the collateral, so the stand-in tests the opening and the balance, which is
what is at stake here.

### Hiding argument (sketch; the full proof is owed)

**Hiding.** An observer sees `V_s = c'·A_c + x_(i+1)·G`, the leaf `Y_(i+1) = x_(i+1)·G +
y_(i+1)·J`, and the Sigma transcript.

- **`Y_(i+1)` says nothing about `x_(i+1)`.** For any candidate `x̂`, there is exactly one `ŷ` with
  `Y = x̂·G + ŷ·J`, and `y_(i+1)` is uniform (pseudorandom from the shared secret). So `Y` is
  perfectly hiding given a uniform `y`, and computationally hiding under the derivation's PRF.
- **So `x_(i+1)` is uniform to the observer, and `V_s` is a perfectly hiding commitment to `c'`.**
  Testing candidates `ĉ` needs `x_(i+1)·G`, which appears nowhere.
- **The Sigma proof** is honest-verifier zero-knowledge, made non-interactive in the random oracle
  model, so it adds nothing.
- **Different indices** use independent `x_i`, so differences between states reveal nothing.

**The exception.** Two builds at the same index share `x_(i+1)`. If both become public, their
difference `(c' − c'')·A_c` gives the difference of the two amounts to the same search. The phase 5
rule of rebroadcasting a saved build, never rebuilding, must cover the successor as well.

### Binding argument (sketch)

**`i` is bound to the asset commitment's step.**

- The program requires the input's asset commitment to equal `A_c + i·G`, and the successor's to
  equal the input's plus `G`.
- The map `i ↦ A_c + i·G` is injective for `i < n`.
- So a loan output has exactly one index, and its successor has the next one.
- The real chain starts at `A_c` at acceptance, so its `k`-th state has index `k`, which the lender
  counts on the chain.

**The leaf is bound to the root**, under collision resistance of the SHA-256 compression function
with fixed IVs.

**`x` is bound to the leaf.**

- E3 opens `Y_(i+1)` in the bases `G` and `J`.
- Pedersen binding, with `J`'s logarithm unknown, makes `x = x_(i+1)`.
- E2 then fixes `V_s − x_(i+1)·G = c'·A_c`, which is what the lender's search solves.

**Off the real chain.** Someone can send an output with asset commitment `A_c + j·G` to the loan's
address and run an installment on it. That spends their own coins, and it can only reuse an index's
`x` against their own privacy. The lender follows the chain from acceptance.

### The search, measured

The search is `bsgs/src/lib.rs`: k256 projective additions, batch normalization in chunks of
4,096, and a table keyed by 8 bytes of x. It is not tuned. It was run worst-case (`c' = 2^bits − 1`)
on an Apple M4 Pro:

| Bound on C | Native (release, LTO) | Native RSS | wasm in node 26 | wasm memory |
|---|---|---|---|---|
| 2^36 | 1.66 s | 11 MB | 2.36 s | 11 MiB |
| 2^40 | 6.51 s | 38 MB | 9.44 s | 45 MiB |
| 2^44 | 25.81 s | 145 MB | 38.18 s | 138 MiB |

- The wasm module builds for `wasm32-unknown-unknown` with no imports.
- On regtest, a dev build found the regtest loan's `c'` in 4.7 s, with `C ≈ 2^40`.
- **wasm costs about 1.45× native** on this machine. Phones and older laptops will be several
  times slower (estimate).
- Batched affine additions should be several times faster, but that is not measured.
- **The cap on C** is the lender's choice at acceptance. `2^40` base units is about 11,000 BTC in
  sats.

### Repair cost

The repair adds equation E3, the index check, and the Merkle path. Its cost is inside the measured
3,841,336 mWU and is not separated (section 3). Counted, it is about 250,000 mWU and about 400
witness bytes.

### Repair enforcement, tested

Each tamper below keeps every other check true by construction, so it isolates one check. Each was
refused by the program on regtest, at installment 2, while the honest installment 2 next to it
confirmed. The SDK reports only that a jet failed, not which.

| Tamper | Check it isolates |
|---|---|
| Successor with a random value blinder, honest `Y_(i+1)` | E3 (`x` must open `Y`) |
| Random blinder, self-made `Y' = x'·G + y'·J`, honest path | the Merkle root |
| Index, leaf and blinder of `i + 1`, at step `i` | the index check `A_c + i·G` |
| Leaf and blinder of `i + 1`, index `i` | the path's index |

## 3. Route C on regtest (measured)

**The setup.** `regtest/` is a throwaway crate with its own `[workspace]`. It runs under
`simplex test` with the repo's `ConfidentialTransaction` and `private-lending-core`.

- `regtest/simf/route_c_head.simf` holds the helpers of `private_lending.simf`, copied unchanged.
- `regtest/simf/route_c_tail.simf` holds the new installment: the storage check, `D' = D − V`,
  the successor's storage and its `+G` asset step, the index check, the Merkle path, and E1–E7.
- The test is `regtest/tests/route_c.rs`.

**The amounts.**

- `C = 2^40 − 2^20` and `R = 5C/4`, so `e' = 0` whenever 5 divides `d'`.
- Installment 1 pays about 1/3 of the debt, chosen so that `e' = 0` (carries of 1 and `R`).
  Installment 2 pays about 1/2 of what is left, with `e'' = C`.
- Each installment goes to an address with a blinding key the lender does not have.

| Transaction | Weight | In / out | Stack | Program | Witness | Cost mWU | Budget mWU |
|---|---|---|---|---|---|---|---|
| Installment 1 (from issuance) | 46,931 | 4 / 9 | 7,296 | 5,938 | 1,220 | 3,794,296 | 7,346,000 |
| **Installment 2 (steady)** | **42,479** | 5 / 8 | 7,367 | 6,009 | 1,220 | 3,841,336 | 7,417,000 |
| Liquidation after both | 10,500 | — | — | — | — | — | — |
| Today's installment (phase 5) | 24,794 | 4 / 6 | 4,033 | 3,864 | 33 | 934,252 | 4,083,000 |

Weights in WU and sizes in bytes; "Stack" is the loan input's script witness.

- **Both installments paid for their own cost**, at 52% of budget. No padding.
- **Steady-state outputs:** the successor, the installment, `W1`, `W2`, the release, the repayment
  change, the policy change, and the fee.
  - Each confidential output has a 4,174 B range proof and a 131 B surjection proof, about 4,800
    WU in all.
- **Where the 17,700 WU over today's transaction goes:**
  - The two carries: 2 outputs and 2 inputs, about 10,200 WU.
  - The release output: about 4,800 WU.
  - The loan input: +3,200 WU.
- **Not in the spike:**
  - The borrower NFT's input and output, about +500 WU (estimate).
  - The pinned installment script, which costs a few thousand mWU.
- **The real contract's installment is therefore about 43,000 WU** (estimate from the measured
  transaction).
- **Refused, at the program's execution when the transaction is built** ("Jet failed during
  execution"):
  - A successor holding `c' + 1`, with the release adjusted to balance.
  - Carries split `(e', R − e' + 1)`: the right total, the wrong `e'`.
  - The four repair tampers (section 2).
  - Consensus runs the same program, so a node refuses them. I did not broadcast them.
- **A zero carry is routine and works.** `e' = 0` whenever `R` divides `d'·C`. With `C = R` that
  is every installment. Installment 1 had `e' = 0` and confirmed, with carries of 1 and `R`.
- **The first installment's carry change** (output 9 of installment 1) is a one-off. Later
  installments spend the two carries and recreate them, with no change.

**Jets used:**

- Today's jets.
- `scale`, `linear_verify_1`, `gej_ge_add`, `gej_normalize` and `generate`.
- `sha_256_block`, `scalar_normalize`, `scalar_negate`, `scalar_add` and `add_16`.

No new jet is needed.

## 4. Route S, corrected for no padding

Route S proves `e' ∈ [0, 2^k)` and `R − 1 − e' ∈ [0, 2^k)` in the program, with bit-OR proofs.

- **Measured per proof:** a 64-bit range proof costs 15,555,503 mWU, against 12,312 B of witness
  and 678 B of program. The 52-bit one costs 12,616,487 mWU against 10,004 B.
- **So it is cost-bound by about 2.5 kB per proof.** The whole input needs about 1.6 kB of padding,
  which Liquid does not relay, so **route S as measured is out**.
- **Restructured to pay for itself (estimate):**
  - Carry `T0` and `T1` affine and check them with `linear_verify_1`.
  - That is about 254 B and 249,000 mWU per bit, which makes the input byte-bound: about
    38,500 WU for 2×64 bits.
  - The transaction would be **about 64,000 WU**, with no carry outputs.
  - A dummy witness value would also pay for itself, but its relay policy is unchecked.
- **Compared with route C**, route S is heavier and needs its own range-proof code and soundness
  proof. Route C's bounds come from Elements' range proofs.

Measured building blocks, all from `proto/`:

| What | Cost (mWU) | Program | Witness | Result |
|---|---|---|---|---|
| 64-bit bit-OR range proof (`sha_256_block` challenge) | 15,555,503 | 678 B | 12,312 B | ok |
| 64-bit, one response altered | — | — | — | rejected |
| 64-bit with the `Ctx8` streaming hash | 30,251,183 | 730 B | 12,312 B | ok |
| Sigma (1)–(3) of the first pass | 622,875 | 798 B | 352 B | ok |
| `array_fold`, 64 × (`scale` + `gej_add`) | 6,066,917 | 2,594 B | 0 | ok |
| `for_while` (u8), exit after 64 of the same | 7,352,733 | 703 B | 0 | ok |

Lessons for SimplicityHL:

- Use `array_fold` for loops: it costs about 19,000 mWU of overhead per iteration.
- Hash with `sha_256_block`. The `Ctx8` streaming API doubles the cost.
- Wide `let` bindings cost per bit.

## 5. BP++ from the user's fork, against route C's carries

The fork (`~/Projects/dl/zero-art/bulletproofs`, `docs/simplicity-verifier.md`) gives:

- an R1CS circuit on BP++ over secp256k1, with a SHA-256 transcript;
- a compiler to Simplicity;
- measured input weights that pay for themselves: 16 gates 10.6 kWU, 32 gates 16.9, 64 gates
  29.7, 128 gates 54.2.

Its commitments `V` are program constants. Here `V` would be a witness point `E'` under base `A`,
linked by E7 in place of the carries' E4–E6.

**Two ways to bound `e'`:**

| | Route C: carries | Sigma link plus a BP++ program |
|---|---|---|
| Range of `e'` | consensus range proofs of 2 outputs | 2 ranges in the program |
| Weight it adds | ~10,200 WU (2 outputs, 2 inputs) | ~16,900 to ~54,000 WU (fork's table) |
| Installment | ~43,000 WU (measured spike + NFT) | ~49,000 to ~86,000 WU (estimate) |
| New verifier code | none for the range | the fork's compiler output, unaudited |
| Other costs | a worthless token, 2 outputs per installment | none on chain |

The gate count of a range decides the BP++ column, and I did not verify it:

- **Low end, about 49,000 WU.** A reciprocal range proof uses one multiplication per digit:
  `bp-pp`'s `u64` proof has 16 hex digits, and the fork's `bppp/range.rs` uses the same
  digits-as-poles form. Two values would then be about 32 gates, which the fork's table puts at
  16.9 kWU.
  - The program is byte-bound at about 22.9 kB: 16.3 kB of BP++ program, 0.5 kB of proof and about
    6 kB of the rest.
  - That replaces the carries (about 10,200 WU) and grows the loan input from about 7,400 WU to
    about 22,900 WU.
- **High end, about 86,000 WU (77,000 at 52 bits).** Two 64-bit ranges as bit constraints are 128
  gates, 54.2 kWU in the fork's table, so the input is byte-bound at about 60 kB.
- **The two ends rest on an assumption:** a range circuit of `n` gates weighs like the fork's chain
  of `n` multiplications.
  - The fork's only measured lookup circuit, a 256-row table with 8 lookups, is 70.2 kWU. So
    lookups can cost far more than a chain of the same size.
  - The decisive measurement is the fork compiling two 64-bit reciprocal ranges, which belongs to
    the fork's owner.
- **What BP++ would buy:** no carry token, no extra outputs, and no carries linking a borrower's
  loans.
- **What it would cost:** about 6,000 WU more per installment at best, plus an unaudited verifier
  in the trusted path.
- **Its `V`:** the fork takes `V` as program constants, so it would become a witness point `E'`
  under base `A`, linked by E7 in place of the carries' E4–E6.

## 6. Baseline: a release the lender co-signs (estimate)

The installment branch adds one `bip_0340_verify` (49,087 mWU) under a lender key, plus a release
output. There is no proof.

- **Transaction:**
  - Today's measured 24,794 WU.
  - Plus a release output of about 4,800 WU.
  - Plus a 64 B signature and a little program.
  - **About 29,700 WU.**
- **Cost:** about 0.98 M mWU, paid for by the ~4 kB input.
- **Trust:** the lender checks the successor's and the release's openings off chain before
  signing, so it can always liquidate.
- **Drawbacks:**
  - Each release needs the lender online, and the lender can refuse.
  - The full repayment does not depend on the lender, so the borrower keeps its exit.
- Against route C (about 43,000 WU) it saves about 13,300 WU per installment, and trades
  unilateral releases for interaction.

## 7. Conditions and risks

**Liquidation.** It reads neither the proof nor the collateral. With the repair, the lender opens
the collateral from `x_i`, `C`, `a_c`, the installment count and the chain alone, as shown on
regtest. The cap on C makes the search bounded.

**Full repayment.** It stays reachable from every reachable state. The branch is unchanged, and an
installment's proof can only make that installment fail.

**Rebuild from seed and chain:**

- `c'` follows from `d'`, `C` and `R`.
- `x_i` and `y_i` are derived.
- The carries are the borrower's own outputs. If they are lost, the borrower issues a new token.

**Releases add up exactly.** By construction (section 1); shown on two installments.

**Soundness proofs owed:**

- **E1–E7:** special soundness with shared responses, and the integer lifting argument
  (section 1).
- **The Fiat–Shamir challenge:** chained `sha_256_block` compressions with fixed-length input, no
  padding, and `FS_IV` as the chaining value, modeled as a random oracle.
- **The repair:**
  - hiding of `Y_i`, and joint pseudorandomness of the `x_i` and `y_i`;
  - binding of the index;
  - Merkle collision resistance under fixed IVs.
- **Route C:** that consensus bounds a spendable confidential amount to `[1, 2^64)`, that a pinned
  `CARRY_SCRIPT_HASH` stays spendable, and that surjection proofs keep the carries' generators
  unopenable.
- **Route S only:** the CDS OR bit proof.

**Unaudited new code:**

- the SimplicityHL installment branch (`regtest/simf/route_c_tail.simf`, about 190 lines);
- the k256 prover and the lender's opening (in `regtest/tests/route_c.rs`);
- the Merkle tree;
- the lender's search.

**Open items:**

- The number of installments is capped at `N` (1024 in the spike).
- The rebuild-at-the-same-index leak (section 2).
- The search time on slow devices.
- Each wallet needs a carry token; reusing it links a borrower's loans.

## Sources

- **Budget rule:** `simplicity-lang-0.7.0/src/analysis.rs` (`is_budget_valid`).
- **Annex policy:** the user's fork, `docs/simplicity-verifier.md` (Elements PR 1539).
- **Jet costs:** `simplicity-lang-0.7.0/src/jet/init/core.rs`, `fn cost`.
- **Jet semantics:** `simplicity-sys-0.6.2/depend/simplicity/jets-secp256k1.c`.
- **SimplicityHL:** `simplicityhl-0.5.0/src/ast.rs` and `src/compile/mod.rs`.
- **Elements range proofs:**
  - [sigcache.cpp][sigcache];
  - [confidential_validation.cpp][confval];
  - `rangeproof_impl.h` (secp256k1-zkp-sys 0.10.1).
- **BP++:**
  - [ePrint 2022/510](https://eprint.iacr.org/2022/510);
  - [ePrint 2026/2648](https://eprint.iacr.org/2026/2648);
  - [distributed-lab/bp-pp](https://github.com/distributed-lab/bp-pp);
  - the user's fork, `docs/simplicity-verifier.md` (Measurements).
- **CDS OR proofs:** Cramer, Damgård, Schoenmakers, CRYPTO '94.
- **Spec:** "Phase 5 design note", `docs/superpowers/specs/2026-11-06-private-lending-v2-design.md`.

[sigcache]: https://github.com/ElementsProject/elements/blob/master/src/script/sigcache.cpp
[confval]:
  https://github.com/ElementsProject/elements/blob/master/src/confidential_validation.cpp
