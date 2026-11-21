# Phase 7 soundness proofs: proportional collateral release

Written 2026-11-21 for phase 7, task 1. The proofs are against the spec's "Phase 7 design note"
(`2026-11-06-private-lending-v2-design.md`, commit `59feb04`), called "the note" below, and the
contract is written to the statements proved here. "Note: X" points at the part of the note named
X: its equations E1–E7 and V1–V7, equation M, the installment checks 1–11, the challenge's layout,
and so on.

## 0. Status

**No statement fails, and the design needs no change.** Every claim in the note's "Done when" for
the proofs, and every claim in the task's brief, is proved below under the assumptions of
section 2. The findings, most important first:

1. **The proofs need weaker assumptions than the note states.** The note asks that the discrete
   logarithms of `A`, `A_c`, `A_w1`, `A_w2` and `J` to base `G` be unknown "and mutually". Every
   step below compares two openings of one point in a single pair of bases `(H, G)`. So it is
   enough that nobody can compute `log_G H` for each `H` on its own (A1). The borrower may even
   choose a carry asset related to `A` or `A_c`, for instance the collateral asset itself, without
   breaking anything. Elements' own asset conservation needs distinct assets to be independent, and
   that is part of the consensus assumption A3, not of these proofs.
2. **The lender's bounds are not needed for soundness.** The integer argument (Theorem 2) holds
   for any `C, R < 2^64`: the coefficient of `A` in E7 is then below `2^139 < n`. The caps
   `C ≤ 2^44` and `R ≤ 2^50 − 2` keep the lender's search fast and fit the carry supply `S`, and
   nothing more. With the caps the coefficient is below `2^119`, and `|d'| < 2^74`; the note's
   `2^121` and `2^75` are correct but loose.
3. **What is load-bearing is the minimum of 1 on three outputs.** The successor's minimum forbids
   the overpayment and the payment of the exact debt. The two carries' minimums keep `e` in
   `[0, R − 1]`. With a carry of 0 allowed, `e = −1` would let the successor hold one unit too
   little, or `e = R` one unit too much (Theorem 2, remarks). All three minimums come from the
   outputs' scripts being spendable (checks 5 and 9).
4. **`FS_IV` is defence in depth.** A prover cannot choose the loan's constants after seeing a
   challenge, so soundness does not depend on `FS_IV` being right (section 6.1). `FS_IV` keeps the
   challenges of different loans apart. Every point the prover chooses or influences is absorbed,
   including the bases `A_w1` and `A_w2` that it picks from the transaction. Leaving one out would
   be the classic weak Fiat–Shamir break.
5. **A precision to the note's reasoning about nonces, not a change.** "The statement fixes every
   secret" is true only computationally. `φ_S` maps `Z_n^11` into `𝔾^7`, so every statement
   has at least `n^4` witnesses. But every nonzero element of the kernel gives away a discrete
   logarithm (Theorem 1(e)), so nobody can compute two. The nonce derivation also needs `h₇` not to
   collide between two of the borrower's statements. Such a collision would reveal `C`, `ρ`, `R`,
   `r₀` (Theorem 6(b)), and it happens only with probability about `2^−256` per pair.
6. **Leaks beyond the one the note states** (section 13):
   - **L2:** the lender learns `c_k` at every step, by design. For an installment it cannot read,
     that gives it the debt to within `⌈R/C⌉` units, and exactly when `C ≥ R`.
   - **L3, new:** the note emits the release output only when the release is positive. The
     output count can then tell an observer whether an installment released anything.
7. **Obligations on the implementation** that the proofs assume (section 13, O1–O8). Chiefly:
   - read `V_s`, `V`, `W1`, `A_w1`, `W2`, `A_w2` as confidential commitments, so that an explicit
     one fails;
   - hash exactly the points that V1–V7 use;
   - never publish a proof that fails the local verifier.
8. **Optional hardening.** Bind the witness into the nonce derivation (R1). Mask the release
   output's presence (R2).

The Fiat–Shamir step loses a square root, as Schnorr signatures do under the forking lemma
(section 6.3).

## 1. Setting

### 1.1 Notation

The note's notation holds (note: "Notation"). In addition:

- `𝔾` is the secp256k1 group, written additively, of prime order `n` with `2^255 < n < 2^256`, and
  `O` is its identity. Scalars are in `Z_n`.
- `f(h, m)` is the SHA-256 compression function (`compress`, `jet::sha_256_block`): chaining value
  `h` of 256 bits, block `m` of 512 bits.
- For a point `P ≠ O`, `⟨P⟩` is its 64 bytes `x ‖ y` (note: "Encodings") and `enc(P)` its Elements
  encoding: the prefix bit by phase 5's square-ness rule, and `x`.
- `Gen(a)` is the generator of asset `a` (secp256k1-zkp's `generator_generate`). The active
  collateral's asset commitment is `A_c = Gen(collateral) + a_c·G`.
- **The real chain** of a loan is the sequence of loan outputs `L_0, L_1, …`:
  - `L_0` is output 0 of the acceptance;
  - `L_(k+1)` is output 1 of the installment that spends `L_k`.

  `L_k` is at step `k`. "An installment" means one that spends an output of the real chain.
- `V_j` is the value commitment of output 2 of the `j`-th installment, and `p_j` its amount.
  `d_k = R − Σ_(j≤k) p_j` is the debt at step `k`.
- `x_j`, `y_j`, `Y_j = x_j·G + y_j·J` (`j = 1..1024`) are the note's blinders and blinder
  commitments, and `BLINDER_ROOT` the root of their tree.

### 1.2 The relation as one linear map

An installment at step `i` has the **statement**

```
S = (D', V_s, W1, A_w1, W2, A_w2, Y)
```

and the loan's constants `K = (A, A_c, V_c0, D₀, J)`. The **witness** is one vector, in the note's
order:

```
w = (C, ρ, c', x, y, e, w1, R, r₀, w2, τ)  ∈  Z_n^11
```

Define `φ_S : Z_n^11 → 𝔾^7` and `X_S ∈ 𝔾^7` by

```
φ_S(w) = ( C·A_c + ρ·G,                        X_S = ( V_c0,
           c'·A_c + x·G,                                V_s,
           x·G + y·J,                                   Y,
           e·A_w1 + w1·G,                               W1 − A_w1,
           R·A + r₀·G,                                  D₀,
           (R − e)·A_w2 + w2·G,                         W2,
           c'·D₀ − C·D' − e·A − τ·G )                   O )
```

E1–E7 say exactly `φ_S(w) = X_S`. The map `φ_S` is `Z_n`-linear:
`φ_S(a·u + b·v) = a·φ_S(u) + b·φ_S(v)`.

**The protocol Σ.** It is Maurer's protocol for a preimage of a group homomorphism [Mau09]:

1. The prover draws `k ← Z_n^11` and sends `T = φ_S(k) = (T1, …, T7)`.
2. The verifier draws `c ← Z_n`.
3. The prover sends `z = k + c·w`.
4. The verifier accepts if and only if `φ_S(z) = T + c·X_S`.

The seven components of step 4 are V1–V7 (note: "The verification equations"):

- V1–V6 read directly. V6's coefficient `z_R − z_e` is component 6 of `φ_S(z)`.
- Component 7 reads `z_c'·D₀ − z_C·D' − z_e·A − z_τ·G = T7 + c·O`, which rearranges to V7.
- The note's honest commitments `T1..T7` are `φ_S(k)`.

The non-interactive proof is `π = (T, z)`, with challenge `c = scalar(h₁₄)` (note: "The
Fiat–Shamir challenge"). Write `c = H_c(FS_IV, S, T)`. The jets reduce responses modulo `n`, so a
response is an element of `Z_n` (L9).

## 2. Model and assumptions

Each theorem names the assumptions it uses. `Adv^x` is the best advantage against assumption `x`
of an adversary of the stated resources.

- **A1, generators.** Let `𝓗` be `{J}` together with every asset commitment that appears in a
  valid transaction. No efficient adversary outputs `H ∈ 𝓗` and `(α, β) ≠ (0, 0)` with
  `α·H + β·G = O`. Its advantage is `Adv^dlg`.
  - `G` has order `n`, so such a pair has `α ≠ 0` and gives `log_G H = −β/α`. A1 therefore says
    that nobody can compute `log_G H`, for each `H` separately.
  - It does **not** say that the elements of `𝓗` are independent of each other (finding 1).
  - Lemma 2.1 derives A1 from the discrete logarithm problem.
- **A2, consensus bounds in knowledge form.** For every valid transaction, an extractor obtains:
  - for every confidential output on a spendable script, with asset commitment `H` and value
    commitment `V`, an opening `(v, s)` with `V = v·H + s·G` and `1 ≤ v < 2^64`;
  - for every confidential asset commitment `H`, its asset `a` and offset `t` with
    `H = Gen(a) + t·G`.

  `Adv^cb` is the probability that it fails. The grounds:
  - the range proof's header bounds `max_value ≤ 2^64 − 1` (`secp256k1_rangeproof_getheader_impl`);
  - `CachingRangeProofChecker::VerifyRangeProof` requires `min_value ≥ 1` for a spendable script
    (both cited in the spike note);
  - range proofs and surjection proofs are proofs of knowledge in the random-oracle model
    [MP15, PBF+18].

  The outputs concerned are 1 (the storage address), 2 (`INSTALLMENT_OUTPUT_SCRIPT_HASH`), and 3
  and 4 (`PRINCIPAL_OUTPUT_SCRIPT_HASH`), all taproot and therefore spendable.
- **A3, Elements' confidential transactions.**
  - Consensus conserves each asset.
  - Amounts and assets of outputs whose blinders are uniform and unknown to an observer stay
    hidden: Pedersen commitments, range proofs and surjection proofs reveal only their public
    ranges.

  A3 is the baseline that the hiding theorem measures the release against. These proofs do not
  re-prove it.
- **A4, SHA-256.** SHA-256 is collision resistant, as phase 5 already assumes for:
  - the storage slot `h(A, D)`;
  - the pinned commitment hashes (`asset_amount_hash`);
  - the taproot commitments of the storage address.

  Its advantage is `Adv^cr-sha`.
- **A5, the compression function under the tree's two fixed IVs.** No efficient adversary finds
  `m ≠ m'` with `f(IV, m) = f(IV, m')` for `IV ∈ {LEAF_IV, NODE_IV}`. Its advantage is
  `Adv^cr-f`.
  - The IVs are fixed constants, so this is weaker than resisting free-start collisions.
  - The best published attacks on the SHA-256 compression function reach reduced-step variants
    only.
- **A6, the PRF of `derive`.** `label ↦ derive(label)` is a pseudorandom function keyed by the
  offer's shared secret. It stays one when the adversary also sees the shared secret's other use,
  the rewinding nonce of the collateral output's range proof (`OfferSecrets`). Its advantage is
  `Adv^prf-derive`. The lender knows the key and the observer does not.
- **A7, the PRF of the nonce derivation.**
  `(h₇, m) ↦ tagged_hash("simplicity-lending/private/v1/release-nonce", borrower_sk ‖ h₇ ‖ m)` is
  a pseudorandom function keyed by `borrower_sk`. It stays one given the key's other uses (its
  public key, ECDH, signatures under other tags). Its advantage is `Adv^prf-nonce`. Neither the
  lender nor the observer knows the key.
- **A8, idealized hashing.**
  - The challenge function `H_c` is a random oracle (Lemma 4.1 justifies this from an ideal `f`).
  - For `J` (Lemma 2.1), SHA-256 is a random oracle.
  - For A1's derivation, `Gen` is a random oracle into `𝔾`.

**The bounds** (note: "The integer argument"):

- `1 ≤ C ≤ 2^44` and `1 ≤ R ≤ 2^50 − 2`, checked by the lender at acceptance;
- the payments, the successor and the carries in `[1, 2^64)`, by A2;
- at most 1024 installments, by Lemma 3.2.

**Lemma 2.1 (A1 from discrete logarithms; `J` is nothing-up-my-sleeve).** Assume A2's second item
and A8. Suppose an adversary breaks A1 with probability `ε`. Then an algorithm `B` solves the
discrete logarithm problem in `𝔾` with probability at least `ε − Adv^cb`, in about the same time.

*Proof.* `B` receives `X` and programs the oracles.

- **`Gen`.** It answers each new query `a` with `X + β_a·G`, for a fresh uniform `β_a`. These
  answers are uniform and independent, as `Gen`'s outputs are in the model.
- **`J`.** It simulates the try-and-increment (note: "`J`"). For `t = 0, 1, …`, it answers
  `SHA-256(tag ‖ t)` with a uniform string that is not a valid x-coordinate, with probability
  equal to the fraction of such strings among 256-bit strings. Otherwise it answers with the
  x-coordinate of `P = X + β_J·G`, and sets `J` to whichever of `±P` has even `y`. `P` is uniform
  in `𝔾`, so `J`'s x-coordinate is uniform over the valid ones, exactly as in the real derivation.

Now suppose the adversary outputs `α·H + β·G = O` with `α ≠ 0`.

- If `H = J = ±(X + β_J·G)`, then `±α·X + (±α·β_J + β)·G = O`, which gives `log_G X`.
- If `H` is an asset commitment, A2 gives `a` and `t` with
  `H = Gen(a) + t·G = X + (β_a + t)·G`. Then `α·X + (α·(β_a + t) + β)·G = O`, so
  `log_G X = −(α·(β_a + t) + β)/α`. ∎

The reduction is tight. It makes every generator `X` plus a known multiple of `G`, so it could not
serve a claim that needs two generators to be independent of each other. None of the claims here
needs that (finding 1).

## 3. The Sigma protocol

**Theorem 1 (Σ for E1–E7 with shared responses).** For every statement `S`:

- **(a) Completeness.** If `φ_S(w) = X_S`, the honest prover is accepted with probability 1.
- **(b) Special soundness.** Take two accepting transcripts `(T, c, z)` and `(T, c*, z*)` with
  `c ≠ c*` in `Z_n`. The extractor `Ext` outputs

  ```
  w = (c − c*)^(−1) · (z − z*)        (coordinate-wise in Z_n)
  ```

  and `φ_S(w) = X_S`. This needs no assumption.
- **(c) One consistent witness.** The extracted `w` gives each secret one value, which holds in
  every equation where the secret appears.
- **(d) Honest-verifier zero knowledge, perfect.** `Sim(S, c)` draws `z ← Z_n^11` uniformly and
  sets `T = φ_S(z) − c·X_S`. For every `c` and every witness `w` of `S`, its output `(T, c, z)` has
  exactly the distribution of an honest transcript with challenge `c`. This holds even for a
  verifier who knows `w`.
- **(e) Computational uniqueness of the witness.** Given any nonzero `δ ∈ ker φ_S`, a relation for
  A1 in one of the pairs `(A_c, G)`, `(A_w1, G)`, `(A, G)` can be computed. So nobody can compute
  two witnesses for one statement, except with probability `Adv^dlg`. Information-theoretically
  there are at least `n^4` witnesses, because `dim ker φ_S ≥ 11 − 7`.

*Proof.*

**(a)** `φ_S(k + c·w) = φ_S(k) + c·φ_S(w) = T + c·X_S`.

**(b)** Subtracting the two verification equations gives `φ_S(z) − φ_S(z*) = (c − c*)·X_S`. By
linearity, `φ_S(z − z*) = (c − c*)·X_S`. Since `n` is prime and `c ≠ c*`, `c − c*` is invertible,
so `φ_S(w) = X_S`.

**(c)** `w` is a single vector, so each secret has one extracted value everywhere:

| Secret | Its equations |
|---|---|
| `C` | E1 and E7 |
| `c'` | E2 and E7 |
| `x` | E2 and E3 |
| `e` | E4, E6 and E7 |
| `R` | E5 and E6 |

This is what ties the integer argument together: E7's `C` is the amount in `V_c0`, its `e` the
carries' split, and its `c'` the successor's amount. Suppose instead that the verifier used two
responses for one secret, say `z_C` in V1 and an independent `z_C°` in V7. The extractor would then
return `C₁`, which opens `V_c0`, and an unrelated `C₇`, and E7 would hold for a `C₇` of the prover's
choice. The note uses one response per secret (`z_C` in V1 and V7, `z_c'` in V2 and V7, `z_x` in
V2 and V3, `z_e` in V4, V6 and V7, `z_R` in V5 and V6), so (b) applies to the whole vector.

**(d)** Fix `c`. In an honest transcript `k` is uniform, so `z = k + c·w` is uniform in `Z_n^11`,
and

```
T = φ_S(k) = φ_S(z) − c·φ_S(w) = φ_S(z) − c·X_S.
```

`Sim` applies the same map to the same distribution of `z`.

**(e)** Write
`δ = (δ_C, δ_ρ, δ_c', δ_x, δ_y, δ_e, δ_w1, δ_R, δ_r₀, δ_w2, δ_τ)` with `φ_S(δ) = (O, …, O)`, and go
through the components in order:

1. `δ_C·A_c + δ_ρ·G = O`. If `δ_C ≠ 0`, this is a relation in `(A_c, G)`. Otherwise `δ_ρ = 0`.
2. `δ_c'·A_c + δ_x·G = O`. Likewise, either a relation or `δ_c' = δ_x = 0`.
3. `δ_x·G + δ_y·J = O` with `δ_x = 0` gives `δ_y·J = O`, so `δ_y = 0`, because `J ≠ O`.
4. `δ_e·A_w1 + δ_w1·G = O`: a relation in `(A_w1, G)`, or `δ_e = δ_w1 = 0`.
5. `δ_R·A + δ_r₀·G = O`: a relation in `(A, G)`, or `δ_R = δ_r₀ = 0`.
6. `(δ_R − δ_e)·A_w2 + δ_w2·G = δ_w2·G = O`, so `δ_w2 = 0`.
7. `δ_c'·D₀ − δ_C·D' − δ_e·A − δ_τ·G = −δ_τ·G = O`, so `δ_τ = 0`.

So `δ = 0` unless one of steps 1, 2, 4 and 5 gave a relation. ∎

## 4. The integer argument

**Theorem 2 (the integer argument).** Let `w = (Ĉ, ρ̂, ĉ', x̂, ŷ, ê, ŵ1, R̂, r̂₀, ŵ2, τ̂)` satisfy
`φ_S(w) = X_S`. Suppose these openings, the **ground truth**, are given:

- **(g1)** `V_c0 = C·A_c + ρ·G` and `D₀ = R·A + r₀·G`, with `1 ≤ C < 2^64` and `1 ≤ R < 2^64`;
- **(g2)** `V_s = v_s·A_c + s·G`, with `1 ≤ v_s < 2^64`;
- **(g3)** `W1 = v1·A_w1 + s1·G` and `W2 = v2·A_w2 + s2·G`, with `1 ≤ v1, v2 < 2^64`;
- **(g4)** `D' = d'·A + r'·G`, with `d'` an integer, `d' ≤ R − 1` and `|d'| < 2^74`;
- **(g5)** `Y = x*·G + y*·J`.

A deterministic polynomial-time algorithm `Rel`, given all of this, either outputs a relation for A1
with `H ∈ {A_c, J, A_w1, A, A_w2}`, or certifies all of the following:

- **(i)** `Ĉ ≡ C`, `R̂ ≡ R`, `ĉ' ≡ v_s`, `x̂ ≡ x*` and `ê ≡ v1 − 1 (mod n)`;
- **(ii)** `e := v1 − 1` satisfies `0 ≤ e ≤ R − 1`, and `v1 + v2 = R + 1`;
- **(iii)** `v_s·R − d'·C = e` over the integers, hence `v_s = ⌈d'·C/R⌉`;
- **(iv)** `d' ≥ 1` and `1 ≤ v_s ≤ C`;
- **(v)** `V_s = v_s·A_c + x*·G`.

*Proof.* Each step compares the witness's equation with the ground truth in one pair `(H, G)`.
Every relation it outputs has `α ≠ 0`, so it is nontrivial.

**Step 1 (E1).** `(Ĉ − C)·A_c + (ρ̂ − ρ)·G = O`. If `Ĉ ≢ C`, output `(A_c, Ĉ − C, ρ̂ − ρ)`.

**Step 2 (E5).** `(R̂ − R)·A + (r̂₀ − r₀)·G = O`. If `R̂ ≢ R`, output that relation in `(A, G)`.

**Step 3 (E2).** `(ĉ' − v_s)·A_c + (x̂ − s)·G = O`. If `ĉ' ≢ v_s`, output it. Otherwise also
`x̂ ≡ s`.

**Step 4 (E3).** `(ŷ − y*)·J + (x̂ − x*)·G = O`. If `x̂ ≢ x*`, then `ŷ ≢ y*`, because otherwise
`(x̂ − x*)·G = O`. Output the relation in `(J, G)`. Otherwise
`V_s = ĉ'·A_c + x̂·G = v_s·A_c + x*·G`, which is (v).

**Step 5 (E4 and E6).**

- E4 against (g3): `ê·A_w1 + ŵ1·G = W1 − A_w1 = (v1 − 1)·A_w1 + s1·G`. So `ê ≡ v1 − 1`, or a
  relation in `(A_w1, G)`.
- E6 against (g3): `(R̂ − ê)·A_w2 + ŵ2·G = v2·A_w2 + s2·G`. So `R − e ≡ v2 (mod n)`, or a relation
  in `(A_w2, G)`.

Over the integers, `e = v1 − 1 ∈ [0, 2^64 − 2]`, so `R − e ∈ [R − 2^64 + 2, R]`, while
`v2 ∈ [1, 2^64 − 1]`. Their difference is below `2^65 < n` in absolute value, so `R − e = v2` over
the integers. Hence `e = R − v2 ≤ R − 1`, `e ≥ 0` and `v1 + v2 = R + 1`, which is (ii).

**Step 6 (E7).** Substituting (g1) and (g4) into E7 gives

```
(ĉ'·R − Ĉ·d' − ê)·A + (ĉ'·r₀ − Ĉ·r' − τ̂)·G = O.
```

Let `a := v_s·R − C·d' − e`, an integer. By steps 1, 3 and 5, `ĉ'·R − Ĉ·d' − ê ≡ a (mod n)`.

- If `a ≢ 0 (mod n)`, output the relation in `(A, G)`.
- Otherwise `|a| ≤ v_s·R + C·|d'| + e < 2^128 + 2^138 + 2^64 < 2^139 < n`, so `a = 0` over the
  integers, which is the first half of (iii). Under the note's caps the bound is
  `2^114 + 2^118 + 2^50 < 2^119`.

From `0 ≤ v_s·R − d'·C = e ≤ R − 1`:

```
d'·C/R  ≤  v_s  ≤  d'·C/R + (R − 1)/R  <  d'·C/R + 1,
```

so the integer `v_s` is `⌈d'·C/R⌉`, which completes (iii).

**Step 7.** For (iv), suppose `d' ≤ 0`. Then `v_s·R = d'·C + e ≤ e ≤ R − 1 < R`, so `v_s < 1`,
which contradicts (g2). So `d' ≥ 1`. And `v_s = ⌈d'·C/R⌉ ≤ ⌈(R − 1)·C/R⌉ ≤ C`. ∎

*Remarks.*

- **What is load-bearing.**
  - The minimum of 1 on `v_s`, `v1` and `v2`, and the maximum `2^64` (A2).
  - `C, R < 2^64`.
  - At most 1024 installments, which bounds `|d'|`.

  The caps `C ≤ 2^44` and `R ≤ 2^50 − 2` are not: they serve the search's time and the carry
  supply. A lender that skipped its acceptance checks would still get the exact release rule (but
  a slow liquidation).
- **The carries' minimums.** Without the minimum of 1 on `W1`, `e = −1` becomes possible, and then
  `v_s·R = d'·C − 1`: the successor holds one unit less than the rule. Without it on `W2`, `e = R`
  lets the successor hold one unit more. The pin of outputs 3 and 4 to a spendable script, with
  confidential commitments (check 9), is what excludes both.
- **The carry asset.** The program does not constrain the carry asset, and the theorem does not
  need it to: steps 5 and 6 hold for any `A_w1` and `A_w2` in `𝓗`.

## 5. Binding of the index and the leaf

**Lemma 3.1 (the real chain).** Under A4, except with probability `Adv^cr-sha`, for every step `k`:

- `L_k`'s asset commitment is `enc(A_c + k·G)`;
- `L_k`'s script hash is the storage address `(active, h(A, D_k))`, with
  `D_k = D₀ − Σ_(j≤k) V_j`;
- the witness's `D` of the installment that spends `L_k` is `D_k`.

*Proof.* By induction on `k`.

- **Step 0.** The acceptance requires output 0's commitment hash to be
  `ACTIVE_COLLATERAL_COMMITMENT` (`ensure_output_commitment` in `accept_offer`). The lender
  recomputes that parameter as `h(enc(A_c), enc(V_c0))` before accepting. Equal hashes of
  different encodings would be a SHA-256 collision. The storage of `L_0` is `(active, h(A, D₀))`.
- **Step `k` to `k + 1`.**
  - Check 1 compares `L_k`'s script hash with the storage address for the witness's `D`. Equal
    addresses with different `h(A, ·)` would be a collision in the taproot commitment or in `h`,
    and so would equal `h` with different `enc(D)`. So `D = D_k`.
  - Check 3 fixes `V = V_(k+1)`, under the asset commitment `A`.
  - Check 5 sets `L_(k+1)`'s storage to `(active, h(A, D_k − V_(k+1)))`.
  - Check 6 sets `L_(k+1)`'s asset commitment to `enc(A_c + k·G + G)`. ∎

**Lemma 3.2 (binding of the index).** If the installment that spends `L_k` is accepted with witness
index `i`, then `i = k` and `k ≤ 1023`. So a loan has at most 1024 installments, and `d_k` sums at
most 1024 payments.

*Proof.*

- The program rebuilds an index from the path's 10 bits and requires it to equal `i`, so
  `0 ≤ i ≤ 1023`.
- Check 7 and Lemma 3.1 give `enc(A_c + i·G) = enc(A_c + k·G)`.
- `enc` is injective on `𝔾 ∖ {O}`: for a given `x`, exactly one of the two points with that `x` has
  a square `y`, and the bit records which.
- So `(i − k)·G = O`, hence `i ≡ k (mod n)`, and `i = k` because `0 ≤ i, k < n`. ∎

**Lemma 3.3 (binding of the leaf).** Let `BLINDER_ROOT` be the honest root of
`Y_1..Y_1024`, which the lender recomputes at acceptance. Suppose the program accepts a witness
`(Ŷ, path, i)`, where `Ŷ` is the 64 bytes of the witness's `y`. Then `Ŷ = ⟨Y_(i+1)⟩`, or a
collision under `LEAF_IV` or `NODE_IV` can be read off the path and the honest tree.

*Proof.* Write the honest tree's nodes as `N_(ℓ,j)`, at level `ℓ` (0 for the leaves) and position
`j`:

```
N_(0,j)   = f(LEAF_IV, ⟨Y_(j+1)⟩)
N_(ℓ+1,j) = f(NODE_IV, N_(ℓ,2j) ‖ N_(ℓ,2j+1))
N_(10,0)  = BLINDER_ROOT
```

Let `b_0..b_9` be the path's bits, so `i = Σ b_ℓ·2^ℓ`, and `s_ℓ` its siblings. The program computes

```
u_0 = f(LEAF_IV, Ŷ),
u_(ℓ+1) = f(NODE_IV, s_ℓ ‖ u_ℓ)   if b_ℓ = 1,
          f(NODE_IV, u_ℓ ‖ s_ℓ)   if b_ℓ = 0,
```

and accepts only if `u_10 = BLINDER_ROOT`. Let `i_ℓ = ⌊i/2^ℓ⌋`.

We show downwards that `u_ℓ = N_(ℓ,i_ℓ)` at every level, or a collision is found.

- **Level 10.** `u_10 = BLINDER_ROOT = N_(10,0)` and `i_10 = 0`.
- **From `ℓ + 1` to `ℓ`.** `u_(ℓ+1) = N_(ℓ+1,i_(ℓ+1))`, and both are values of `f(NODE_IV, ·)`.
  If their 64-byte blocks differ, that is a collision under `NODE_IV`. Otherwise the half on side
  `b_ℓ` agrees: `u_ℓ = N_(ℓ, 2·i_(ℓ+1) + b_ℓ) = N_(ℓ,i_ℓ)`.
- **Level 0.** `f(LEAF_IV, Ŷ) = f(LEAF_IV, ⟨Y_(i+1)⟩)`, so either `Ŷ = ⟨Y_(i+1)⟩` or this is a
  collision under `LEAF_IV`. ∎

*Remarks.*

- The depth is fixed at 10, so a node cannot pose as a leaf, and the proof needs only A5. The
  distinct `LEAF_IV` and `NODE_IV` cost nothing and keep leaves, nodes and the challenge chain
  apart if the layout ever changes.
- The tree binds bytes. A non-canonical encoding of `Y_(i+1)`, such as `x + p`, is another byte
  string, so it is another leaf and fails.
- The on-curve check makes the point the program uses the one those bytes denote.

**Corollary 3.4 (binding of the successor's blinder).** For the installment that spends `L_k`:

- `Y = Y_(k+1) = x_(k+1)·G + y_(k+1)·J`;
- every witness accepted for its statement has `x ≡ x_(k+1)`, or step 4 of Theorem 2 gives a
  relation in `(J, G)`.

So the successor is `c'·A_c + x_(k+1)·G`, and the lender's search solves exactly this equation.
Lemmas 3.1–3.3 cover the note's spike tamper tests "the index, leaf and blinder of `i + 1` at step
`i`" and "the leaf of `i + 1` with index `i`".

## 6. The challenge and extraction

### 6.1 What the challenge absorbs

Every point on which `φ_S` or `X_S` depends, and every commitment, is absorbed:

| Point | Role | Absorbed in |
|---|---|---|
| `A`, `A_c`, `V_c0`, `D₀`, `J` | the loan's constants (E1, E2, E3, E5, E7) | `FS_IV` |
| `D'` | E7; the prover influences it through `V` | `h₁` |
| `V_s` | E2; chosen by the prover | `h₂` |
| `W1`, `A_w1` | E4; both chosen by the prover, `A_w1` a base | `h₃`, `h₄` |
| `W2`, `A_w2` | E6; both chosen by the prover, `A_w2` a base | `h₅`, `h₆` |
| `Y` | E3; chosen by the prover, then bound by M | `h₇` |
| `T1..T7` | the commitments | `h₈..h₁₄` |
| `G`, `O` | fixed | not needed |

- **The points the prover chooses or influences are all absorbed before `c` exists.** Leaving out
  any of them would let a prover fix `T`, learn `c`, and then choose the statement: the weak
  Fiat–Shamir break [BPW12]. This is especially true of the bases `A_w1` and `A_w2`, which the
  prover picks from its own outputs. `W1 − A_w1` is computed from absorbed points.
- **The constants are fixed by the program before any proof.** Absorbing them is not needed for
  soundness, so soundness does not depend on `FS_IV` being right. `FS_IV` keeps the challenges of
  different loans apart, and the lender recomputes it anyway.
- **Not absorbed, and not needed:**
  - `i`, the path and `BLINDER_ROOT` only select and authenticate `Y`, which is absorbed.
  - `D` and `V` enter `φ_S` only through `D'`.
  - The rest of the transaction.

  So a proof is valid in any transaction with the same `S`. Only the borrower NFT's holder can run
  the branch, and within one loan the same `S` means the same successor, the same debt left and
  the same carries. A replayed proof therefore asserts something true of the new transaction too.
  The note's test "a proof from another installment" fails because `S` differs.

### 6.2 The chained compressions as a random oracle

**Lemma 4.1.** Model `f` as an ideal compression function (A8). For each fixed `FS_IV`, the map
`(S, T) ↦ h₁₄` is indifferentiable from a random oracle, with loss `O(q²/2^256)` for `q` queries
to `f`. The oracles of different values of `FS_IV` are independent up to the same loss.

*Proof.*

- For a fixed `FS_IV`, `(S, T) ↦ h₁₄` is the plain Merkle–Damgård iteration of `f` over exactly
  14 blocks from the chaining value `FS_IV`.
- A set of messages of one fixed length is prefix-free. Prefix-free Merkle–Damgård over an ideal
  compression function is indifferentiable from a random oracle [CDMP05].
- **Padding and length.** Their job is to make inputs of arbitrary length prefix-free, which fixed
  length already does. A length extension yields a 15-block value, which no verifier computes.
- **The other uses of `f`** start from `LEAF_IV`, `NODE_IV` or SHA-256's IV. A chaining value of
  one use equal to one of another is a collision or a preimage event of `f`, of probability
  `O(q²/2^256)`.
- **`h₇`** is published as an input of the nonce derivation. It is a function of the public `S`,
  so publishing it changes nothing. ∎

**The challenge as a scalar.** `c = h₁₄ mod n`. Each residue has at most two preimages in
`[0, 2^256)`, so:

- two independent challenges coincide modulo `n` with probability at most `2^−255`;
- the distribution of `c` is within `2^−127` of uniform on `Z_n`.

### 6.3 Extraction by forking

**Theorem 3 (extraction from the non-interactive proof).** Let `𝒜` be an algorithm with access to
`H_c` that makes at most `q` queries to it. Suppose that with probability `ε` it outputs
`(S, π, σ)`, where `π` is accepted for `S` and a predicate `P(S, σ)` holds (`σ` is any side
output). Then the forking algorithm `F^𝒜` below runs `𝒜` twice and outputs `(S, σ, w)` with
`φ_S(w) = X_S` and `P(S, σ)`, with probability

```
frk ≥ ε·(ε/q − 2^−255),    equivalently    ε ≤ √(q·frk) + q·2^−255.
```

*The algorithm `F^𝒜`.*

1. **Wrap `𝒜`.** If the proof `𝒜` outputs uses a challenge it never queried, the wrapper queries
   it, so `q` grows by one. Let `J` be the index of the query `(FS_IV, S, T)`.
2. **Run 1.** Run `𝒜` on a random tape `ω` with oracle answers `h_1, …, h_q`, and obtain `J`,
   `(S, T, z)` and `σ`. Fail if `𝒜` fails.
3. **Run 2.** Rerun `𝒜` on the same `ω`, with the same answers `h_1..h_(J−1)` and fresh answers
   from `J` on. Both runs are identical up to query `J`, so its input `(FS_IV, S, T)` is the same.
4. **Extract.** Suppose run 2 outputs an accepted proof `(T, z')` whose challenge comes from query
   `J`, and `h'_J ≢ h_J (mod n)`. Apply `Ext` of Theorem 1(b) to `(T, c, z)` and `(T, c', z')`,
   and return `(S, σ, w)`, with `σ` from run 1.

*Proof.* The general forking lemma [BN06] gives `frk ≥ ε·(ε/q − 1/h)`, where `1/h` bounds the
probability that the forked answer repeats. Here it must not repeat modulo `n`, which has
probability at most `2^−255` (section 6.2).

The rewinding must also replay the rest of the experiment: the chain, the honest lender and the
other oracles. All of them are run by the reduction and are determined by `ω` and the oracle
answers, so the reduction replays them. ∎

**The loss.** The bound loses a square root and a factor `q`, as the Schnorr signature does under
the forking lemma [PS00, BN06]. For example, take `q = 2^64` and a discrete-logarithm advantage of
`2^−96` (about `2^80` generic work): the bound is `2^−16`.

- In the algebraic group model with random oracles, Schnorr signatures have a tight reduction
  [FPS20], and the same is likely here. That is not proved in this document.
- Concrete parameters therefore rest on the same heuristic confidence as Schnorr signatures over
  secp256k1.

## 7. Soundness of the installment

**The experiment `SOUND`.**

- **The honest lender** makes or accepts offers after its checks: the bounds, and every parameter
  recomputed, including `BLINDER_ROOT` and `FS_IV`.
- **The adversary `𝒜`** is the borrower and everyone else. It holds the shared secret and every
  derived value, and builds any transactions it likes. Consensus validates them.
- **`𝒜` wins** if, for a loan that the lender accepted, the real chain contains an accepted
  installment that spends `L_k` and does **not** satisfy all of the following. Here `p_j` are the
  A2 amounts of the installments' outputs 2, `d' = R − Σ_(j≤k+1) p_j`, and `v_s` is the A2 amount
  of `L_(k+1)`:
  - `d' ≥ 1`;
  - `v_s = ⌈d'·C/R⌉`;
  - `V_s = v_s·A_c + x_(k+1)·G`.

**Theorem 4 (soundness).** Assume A1, A2, A4, A5 and A8. Let `𝒜` make at most `q` queries to `H_c`.
Then

```
Adv^sound(𝒜) ≤ Adv^cr-sha + Adv^cr-f + Adv^cb + q·2^−255 + √(q·Adv^dlg(B)),
```

where `B` runs `𝒜` twice, plus the extractors. By Lemma 2.1, `Adv^dlg` is in turn at most the
discrete-logarithm advantage plus `Adv^cb`.

*Proof.*

**Game 0** is `SOUND`.

**Game 1** aborts if a SHA-256 collision, or a collision under `LEAF_IV` or `NODE_IV`, appears in
the run, as Lemmas 3.1–3.3 extract them. The loss is at most `Adv^cr-sha + Adv^cr-f`.

**Game 2** runs A2's extractor on the loan's transactions and aborts if it fails. The loss is at
most `Adv^cb`.

**The predicate.** In game 2, let the first winning installment spend `L_k`, with statement `S`.
Let `σ` be `k` together with the openings below, and `P(S, σ)` the statement that the conclusion
fails. The hypotheses of Theorem 2 hold:

- **(g1)** comes from the parameters: the lender's own `C`, `ρ`, `R` and `r₀`, with
  `1 ≤ C ≤ 2^44` and `1 ≤ R ≤ 2^50 − 2` checked at acceptance.
- **(g2)** By Lemma 3.1, output 1's asset commitment is `A_c + (k+1)·G`. A2 gives `V_s =
  v_s·(A_c + (k+1)·G) + s₀·G`, so `V_s = v_s·A_c + s·G` with `s = v_s·(k+1) + s₀` and
  `1 ≤ v_s < 2^64`.
- **(g3)** Outputs 3 and 4 are on a spendable script and confidential (check 9), so A2 applies.
- **(g4)** Lemma 3.1 gives `D' = D₀ − Σ_(j≤k+1) V_j`. Each output 2 is spendable with asset
  commitment `A` (check 3), so A2 gives `V_j = p_j·A + q_j·G` with `1 ≤ p_j < 2^64`. So
  `d' = R − Σ p_j` and `r' = r₀ − Σ q_j`. By Lemma 3.2 there are at most 1024 terms, so
  `d' ≤ R − 1` and `d' > R − 2^74`, which gives `|d'| < 2^74`.
- **(g5)** is Corollary 3.4: `Y = Y_(k+1)`, with the derived `x_(k+1)` and `y_(k+1)`, which the
  reduction knows because it plays the lender.

**Forking.** Theorem 3 with `P` yields `w` with `φ_S(w) = X_S` and `P(S, σ)`. Given the ground
truth, Theorem 2 cannot certify the conclusion, because `P` says it fails. So `Rel` outputs a
relation for A1, which `B` returns. Therefore `frk ≤ Adv^dlg(B)`, and Theorem 3 gives
`Pr[𝒜 wins game 2] ≤ √(q·Adv^dlg(B)) + q·2^−255`. ∎

**Corollary 4.1 (what the contract enforces).** Except with the probability of Theorem 4, the
following hold along the real chain.

- **(a) No overpayment, and no payment of the exact debt.** Every installment leaves `d_k ≥ 1`.
  - The zero-debt state is unreachable, so removing the zero-debt close removes no exit.
  - The full repayment, with output `D_k` of amount `d_k ≥ 1`, stays buildable by a borrower who
    knows `(d_k, r_k)`.
  - This covers the note's tests "an overpayment" and "a payment of exactly the debt".
- **(b) The release rule.**
  - Write `c_k` for `L_k`'s amount. Then `c_0 = C` and `c_k = ⌈d_k·C/R⌉` for `k ≥ 1`.
  - `d_k < d_(k−1)`, so installment `k` releases `c_(k−1) − c_k ≥ 0`. By A3 this is exactly the
    collateral that leaves the loan.
  - The release so far is `C − c_k = ⌊(R − d_k)·C/R⌋ = ⌊paid_k·C/R⌋`, because
    `C − ⌈y⌉ = ⌊C − y⌋`. With the full repayment's `c_k`, the releases add up to `C`.
  - This covers the tests "`c' ± 1`" and "carries split `(e, R − e + 1)`, or summing to anything
    but `R + 1`" (Theorem 2(ii)).
- **(c) The successor's opening** is amount `c_(k+1)`, asset blinder `a_c + k + 1` and value
  blinder `x_(k+1) − c_(k+1)·(k+1)`. Indeed:

  ```
  c_(k+1)·(A_c + (k+1)·G) + (x_(k+1) − c_(k+1)·(k+1))·G = c_(k+1)·A_c + x_(k+1)·G = V_s.
  ```

## 8. Zero knowledge of the proof

**Theorem 5 (zero knowledge).** Assume A7 and A8. In the random-oracle model for `H_c`, a simulator
`Sim`, given only `S` and `K` and allowed to program `H_c`, outputs proofs with the following
property. Let `D` be a distinguisher that:

- makes `q` queries to `H_c`;
- sees `q_s` proofs;
- holds any auxiliary input that excludes `borrower_sk`. That includes the shared secret and all
  that derives from it (the lender's knowledge), and even the full witnesses.

Then `D` tells the real proofs from `Sim`'s with advantage at most

```
ε_zk = Adv^prf-nonce + 11·q_s·2^−127 + q_s·(q + q_s)/n + q_s²·2^−256.
```

*The simulator.* On a new `S`:

1. Draw `h ← {0,1}^256`, and set `c = h mod n`.
2. Draw `z ← Z_n^11`, and set `T = φ_S(z) − c·X_S`.
3. If `H_c(FS_IV, S, T)` is already defined, abort. Otherwise program it to `h`.
4. Output `(T, z)`.

On an `S` it has seen before, it repeats its earlier output, as the honest prover does (Theorem 6).
In the ideal-compression model, step 3 programs the last compression `f(h₁₃, ⟨T7⟩)`, where `h₁₃` is
fresh.

*Proof.* By hybrids.

- **H0** is the real prover, with nonces derived from `borrower_sk` over `(h₇, m)`.
- **H1** replaces the derivation by a random function. The loss is at most `Adv^prf-nonce`. Then
  `scalar` of a uniform string is within `2^−127` of uniform per nonce, which costs
  `11·q_s·2^−127` in all.
- **H2** adds that distinct statements have distinct `h₇`. They collide with probability at most
  `q_s²·2^−256` (section 6.2). With distinct `h₇`, the nonces of distinct statements are
  independent and uniform. A repeated statement gets the identical proof (Theorem 6(a)).
- **H3** is `Sim`.
  - In H2, `T1 = k_C·A_c + k_ρ·G` is uniform in `𝔾`. So the input `(FS_IV, S, T)` was queried
    before with probability at most `(q + q_s)/n`.
  - Otherwise `c` is a fresh oracle output, as in `Sim`, and by Theorem 1(d) the transcripts
    `(T, c, z)` of H2 and H3 have the same distribution, for every witness and so for every
    auxiliary input that `D` holds. ∎

*Consequences.*

- **Against an observer,** a proof reveals nothing beyond `S`.
- **Against the lender,** a proof also reveals nothing beyond `S`.
  - The lender knows `C`, `ρ`, `R`, `r₀`, `x` and `y`, so it learns six of the eleven nonces of
    every proof, for instance `k_C = z_C − c·C`.
  - The other five, for `c'`, `e`, `w1`, `w2` and `τ`, are independent PRF outputs, and `Sim`'s
    proofs are distributed identically given the lender's secrets.
  - So `z_c'`, `z_e`, `z_w1`, `z_w2` and `z_τ` reveal nothing more about the borrower's carry
    openings or the debt's blinder. What `S` itself reveals is the subject of Theorem 7.

## 9. The nonce derivation

**Theorem 6 (the nonces from `borrower_sk` over `h₇`).** Assume A1, A7 and A8.

- **(a)** Two proofs by the honest borrower with the same `h₇` are identical, except with the
  probability that `h₇` collides between two distinct statements, or that the borrower computes a
  relation for A1.
- **(b)** A collision of `h₇` between distinct statements would reveal `C`, `ρ`, `R`, `r₀`, and
  every other secret common to the two witnesses. This is why `S ↦ h₇` must be collision resistant.
  For the borrower's own statements a collision has probability about `2^−256` per pair, and no
  one else chooses those statements.
- **(c)** Proofs of distinct statements use independent nonces.
- **(d)** The lender cannot compute the nonces.

*Proof.*

**(a)** `h₇` is a function of `(FS_IV, S)`, so equal `h₇` without a collision means equal `S`.

- The honest borrower computes its witness from its openings: `x = x_(i+1)` and `y = y_(i+1)`, `c'`
  and `e` from the arithmetic, `w1` and `w2` from the carries' blinders, and `τ` from `r'`.
- Two different witnesses for one `S` would give a nonzero element of `ker φ_S`, hence a relation
  (Theorem 1(e)).
- So the witnesses are equal. Then the nonces, `T = φ_S(k)`, `c` and `z` are equal too.

**(b)** Take `S ≠ S'` with one `h₇`.

- The nonces are equal, but `T` differs, because `T4`, `T6` and `T7` depend on `A_w1`, `A_w2` and
  `D'`. So the challenges differ, `c ≠ c'`.
- For a secret common to both witnesses, such as `C`, `z_C − z'_C = (c − c')·C` reveals it.

**(c)** This is A7, for distinct inputs `(h₇, m)`.

**(d)** The lender lacks `borrower_sk`. ∎

*Remarks.*

- **Why the note's choice matters.** If the nonces derived from the shared secret, the lender would
  compute `k` and recover `w = (z − k)/c`: the carries' openings `e`, `w1`, `w2`, and `τ`.
- **The note's reasoning, made precise.** The note justifies the derivation with "the statement
  fixes every secret, because the commitments bind under the unknown discrete logarithms". The
  precise form is Theorem 1(e): many witnesses exist, but nobody can compute two.
- **R1, optional hardening.** Add the witness, or a hash of it, to the nonce's input, as RFC 6979
  and BIP340 bind the message. Under the current derivation, a bug that pairs one statement with a
  second, wrong witness would publish `z − z' = c·(w − w')` once both proofs are out. The cheaper
  fix is obligation O7: never publish a proof that fails the local verifier.

## 10. Hiding of `V_k` given `Y_k`

**Lemma 7.1 (the core, perfect).** For any `c ∈ Z_n`, let `Δ_c` be the distribution of

```
(c·A_c + x·G,  x·G + y·J)      with x, y uniform in Z_n.
```

Then `Δ_c` is uniform on `𝔾²`, the same for every `c`.

*Proof.* The map `(x, y) ↦ (c·A_c + x·G, x·G + y·J)` is injective: equal first components give
`x = x'`, and then `y·J = y'·J` gives `y = y'`, because `J ≠ O` has prime order. `Z_n²` and `𝔾²`
both have `n²` elements, so the map is a bijection. It carries the uniform distribution to the
uniform distribution. ∎

So even an unbounded observer who holds `V_k` and `Y_k` learns nothing about `c_k`. To test a
candidate `ĉ`, it would need `x_k·G = V_k − c_k·A_c`, which appears nowhere.

**Theorem 7 (the observer).** Assume A3, A6, A7 and A8, and that no two successors at the same
step become public (the note's "Never rebuild an index"). Take an observer that:

- sees the whole chain of a loan: every transaction and witness, and the program with its
  parameters;
- knows neither the shared secret nor `borrower_sk`.

Compare its view in two worlds:

- **the real world;**
- **the ideal world,** where for every step `k ≥ 1`:
  - `Y_k` is an independent uniform point, with the tree and `BLINDER_ROOT` computed over these
    points;
  - the proofs are simulated;
  - `L_k`'s value blinder is a fresh uniform scalar, so that `L_k` is an ordinary confidential
    output.

The observer tells the two worlds apart with advantage at most

```
Adv^prf-derive + 2048·2^−127 + ε_zk.
```

In words: whatever the observer learns about `c_k` comes from the confidential transactions
themselves (A3), as for any confidential output. The repair, the leaf, the path and the proof add
nothing.

*Proof.* By hybrids.

- **H0** is the real world.
- **H1** replaces `derive` by a random function. Every derived value becomes uniform and
  independent, including `x_j` and `y_j`. The loss is at most `Adv^prf-derive`, plus `2^−127` per
  `scalar` for the 2048 values `x_j` and `y_j`.
- **H2** simulates the proofs, by Theorem 5 with no auxiliary input. The loss is `ε_zk`.
- **H3** replaces each `Y_k`.
  - In H2, `x_k` appears only in `L_k`'s value commitment, as the blinder `x_k − c_k·k`, and in
    `Y_k`. The simulated proofs use only `S`.
  - The full repayment and the liquidation spend `L_k` with its opening. That is a balanced
    confidential transaction, in which A3 keeps the input's opening hidden.
  - `y_k` appears only in `Y_k = x_k·G + y_k·J`, and `J` generates `𝔾`. So for every fixed `x_k`,
    `Y_k` is uniform and independent of the rest of the view. Replacing it by an independent
    uniform point, and computing the tree over such points, changes nothing.
  - Now `x_k` appears only as `L_k`'s blinder, uniform and independent: an ordinary confidential
    output with a fresh blinder. This hop loses nothing. ∎

Two successors at one step break the hop from H2 to H3, because `x_k` then blinds two outputs. That
is the leak L1.

**Theorem 7′ (what the lender learns).** The lender knows `x_k` and `y_k`.

- **It learns `c_k`.** From `V_k` it computes `c_k·A_c = V_k − x_k·G`, and finds `c_k ∈ [1, C]` by
  the search (Theorem 8). That is the repair's purpose.
- **It learns nothing more from the proof.** By Theorem 5, with the lender's secrets as auxiliary
  input, a proof reveals nothing beyond its statement `S`.
- **Some points of `S` stay closed to it.** It cannot open `W1` and `W2`, which are blinded to the
  borrower's key, nor, for a hand-built installment, `V`. A3 covers these.
- **Consequence for a hand-built installment it cannot rewind.** From `c_k`, `C` and `R`, the
  lender learns `d_k ∈ ((c_k − 1)·R/C, c_k·R/C]`, which holds at most `⌈R/C⌉` integers. When
  `C ≥ R` it learns `d_k` exactly, and then `p_k = d_(k−1) − d_k` whenever it knows `d_(k−1)`
  (L2).
- **For installments that the app builds,** the lender reads `p_k` anyway (phase 5), and nothing
  changes.

## 11. The lender's search

**Theorem 8 (the search recovers the opening).** Let a loan be at step `k ≥ 1` on its real chain.
From the chain and its own secrets, the lender has:

- `C`, `a_c` and `x_k`, derived;
- `k`, by counting the installments on the real chain, or by finding the `k ≤ 1024` with
  `enc(A_c + k·G)` equal to `L_k`'s asset commitment (Lemma 3.1);
- `V_k`, read from `L_k`.

**The algorithm.**

1. Compute `Q = V_k − x_k·G`.
2. Find `c ∈ [1, C]` with `c·A_c = Q`, by baby-step giant-step or any complete search.
3. Output `(c, a_c + k, x_k − c·k)`.

Assume what Theorem 4 assumes. Then, except with its probability:

- the search finds `c = c_k`, the only solution in `[1, C]`;
- `(c, a_c + k, x_k − c·k)` opens `L_k`.

The lender opens no installment. It needs only `D_k` as a point, for `h(A, D_k)`, as in phase 5.

*Proof.*

- **Completeness.** Corollary 4.1(c), for the installment that created `L_k`, gives
  `V_k = c_k·A_c + x_k·G` with `c_k = ⌈d_k·C/R⌉ ∈ [1, C]`. So `Q = c_k·A_c`, and a complete search
  over `[1, C]` finds it.
- **Uniqueness.** `c·A_c = c'·A_c` with `c, c' ∈ [1, C] ⊂ [1, n)` gives `c ≡ c' (mod n)`, so
  `c = c'`.
- **The opening.**
  - Asset: `L_k`'s asset commitment is `A_c + k·G = Gen(collateral) + (a_c + k)·G`, by Lemma 3.1.
  - Value: `c_k·(A_c + k·G) + (x_k − c_k·k)·G = V_k`. ∎

*Remarks.*

- Step 0's opening is `(C, a_c, ρ)`.
- When the lender can read every installment, it computes `c_k = ⌈d_k·C/R⌉` directly. The theorem
  says the two methods agree.
- Baby-step giant-step costs about `2·√C` group operations and `√C` memory: `2^23` operations at
  `C = 2^44`, measured at 38 s in wasm by the spike.
- An output that someone sends to the loan's address is not on the real chain, and the lender
  ignores it, as in phase 5.
- This covers the liveness test "the liquidation after the term succeeds, by a lender who reads no
  installment and opens the collateral by the search".

## 12. Completeness

**Proposition 9.** An honest borrower at step `i ≤ 1023`, with debt `d_i ≥ 2` and a payment
`p ∈ [1, d_i − 1]`, produces an installment that the program accepts. It fails only if an
intermediate point is the point at infinity, which happens with probability about `1/n` per point
over the blinders.

*Proof.*

- `d' = d_i − p ≥ 1`, so `c' = ⌈d'·C/R⌉ ∈ [1, C]` and `e = c'·R − d'·C ∈ [0, R − 1]`.
- The carries hold `e + 1` and `R − e`, both in `[1, R] ⊂ [1, 2^64)`. The successor's amount `c'`
  is at least 1.
- The first installment spends the supply `S = 2^50 ≥ R + 2`, and burns `S − R − 1 ≥ 1`.
- The witness satisfies E1–E7: E7 holds with `τ = c'·r₀ − C·r'`, because `c'·R − d'·C − e = 0`.
- The index and the path are the honest ones (Lemmas 3.2 and 3.3).
- V1–V7 hold by Theorem 1(a).
- The honest `T`s and `Y` are curve points. ∎

The edges `e = 0` and `e = R − 1` give the carries `(1, R)` and `(R, 1)`. A release of 0 is
`c' = c_i`.

## 13. Limitations and obligations

### Leaks

- **L1, the rebuild at the same index.** Two public successors at one step share `x_(k+1)`:

  ```
  V = c·A_c + x_(k+1)·G,    V' = c''·A_c + x_(k+1)·G,    V − V' = (c − c'')·A_c.
  ```

  - Baby-step giant-step over `[−C, C]` recovers `c − c''` in about `2·√(2C)` operations.
  - The two builds also carry the same `Y_(k+1)`, the same leaf and the same path, so they are
    linked before any search.
  - The proofs add nothing (Theorem 6): different statements have independent nonces, and the same
    statement has the same proof.
  - Phase 5's range-proof nonce reuse is a separate leak of the same event.
  - The only defence is the app's rule: save a build before its first broadcast and rebroadcast it.
    A build that never becomes public leaks nothing.
  - The same holds for anyone who sends an output with asset commitment `A_c + j·G` to the loan's
    address and runs an installment on it. Only the borrower or the lender knows `a_c`, so such a
    party can only hurt its own privacy.
- **L2, the lender learns `c_k`** at every step, by design (Theorem 7′).
  - Against the lender, a hand-built installment's payment is therefore hidden only to a
    resolution of `⌈R/C⌉`, and not at all when `C ≥ R`.
  - Phase 5 hid it entirely.
- **L3, the presence of the release output.** The note emits the release output only when
  `c_k − c_(k+1) > 0`.
  - An observer who can tell the release output from the change outputs, for instance by the
    output count, learns whether an installment released anything, a bit about the payment's
    size.
  - This lies outside Theorem 7, which concerns the commitments, and A3 does not hide output
    counts.
  - **R2, a fix:** always emit one more confidential output to the borrower, so that the count
    does not depend on the release.
- **L4, the step count is public:** `L_k`'s asset commitment is `A_c + k·G`. Phase 5 accepted this.

### Not covered

- **L5, outside these proofs:**
  - Elements' own soundness and privacy (A2, A3), including what surjection proofs reveal about
    their input sets.
  - Side channels: the prover's scalar multiplications with secrets, the timing of the search, and
    fault attacks on deterministically derived nonces.
  - The faithfulness of the Simplicity implementation to these equations: the jets' semantics
    (`linear_verify_1`, `scale`, `gej_ge_add`, `gej_normalize`, `scalar_normalize`, `decompress`,
    `fe_square_root`, `ge_is_on_curve`), phase 5's encoding conversions, the witness's parsing and
    the exact hashing layout. Tests and review cover these, not proofs.
  - The search's implementation, the indexer, the user interface, and key management.
  - The liveness of the chain itself (fees, relay, the budget and the 100,000 WU limit).
- **L6, quantum adversaries.** A quantum adversary breaks A1, and with it soundness. No claim is
  made against one.
- **L7, the heuristics.**
  - The soundness bound is non-tight (section 6.3).
  - It holds in the ideal-compression and random-oracle models.
  - It composes the knowledge extractors of A2 with rewinding, at the usual level of rigour for
    such compositions. Only run 1's transactions are extracted, which keeps the composition simple.
- **L8, the carry asset is not checked by the program.** The proofs do not need it (Theorem 2,
  remarks). A borrower that pays its carries in another asset harms only itself.
- **L9, the responses are malleable modulo `n`.** A third party can replace a response `z` by
  `z + n`, where that is below `2^256`, and the proof stays valid.
  - The witness changes, but the transaction id does not.
  - Only the borrower NFT's holder can run the branch, so soundness needs no simulation soundness.
  - In any case, Fiat–Shamir over a special-sound protocol with unique responses modulo `n` is
    simulation-extractable [FKMV12].

### Obligations on the implementation

The proofs assume all of these:

- **O1.** The program reads `V_s`, `V`, `W1`, `A_w1`, `W2` and `A_w2` as confidential commitments
  (`unwrap_left`), so that an explicit one fails. A2 bounds only confidential amounts.
- **O2.** Every point in `φ_S` is a curve point:
  - the `T`s and `Y` pass `ge_is_on_curve`;
  - `D` passes decompression;
  - the other points come from decompressing commitments, or from the checked parameters.

  The jets' addition formulas do not use the curve's constant `b`, so an unchecked point off the
  curve would admit invalid-curve attacks.
- **O3.** The challenge absorbs exactly the points that V1–V7 use, in the note's order, and the
  program uses the very points it hashed.
- **O4.** The index is rebuilt from exactly 10 bits and compared with `i`.
- **O5.** Every normalization of a point at infinity fails (`unwrap`), so no check silently uses
  `O`. Check 4 covers `D'`.
- **O6.** `J`, `LEAF_IV`, `NODE_IV` and `FS_IV` are fixed by known-answer tests. In `J`'s
  derivation, an `X_t ≥ p` is rejected, not reduced. Reducing it would only bias `J` by
  `2^−224`, but rejecting keeps the derivation exactly as stated.
- **O7.** The app verifies each proof with the Rust verifier before broadcasting it (Theorem 6,
  remarks).
- **O8.** Phase 5's encoding conversions are correct for both prefix bits. A point read as its
  negation would change the sign of an amount and void the integer argument.

## 14. Map of the claims

| Claim | Where | The note's part it covers | Assumptions |
|---|---|---|---|
| Special soundness, HVZK, shared responses | Thm 1 | E1–E7, V1–V7, one response per secret | none |
| The integer argument | Thm 2, Thm 4 | "The integer argument", its bounds | A1, A2 |
| No overpayment, release rule | Cor 4.1 | the statement; client rules | as Thm 4 |
| Challenge as a random oracle | §6.1, Lem 4.1, Thm 3 | "The Fiat–Shamir challenge", `FS_IV` | A8 |
| Binding of the index | Lem 3.1, 3.2 | checks 1, 5, 6, 7; the acceptance pin | A4 |
| Binding of the leaf | Lem 3.3, Cor 3.4 | "The Merkle tree", check 8, E3 | A5, A1 |
| Soundness of the installment | Thm 4 | checks 1–11 | A1, A2, A4, A5, A8 |
| `J` nothing-up-my-sleeve | Lem 2.1 | "`J`" | A8 |
| Zero knowledge | Thm 5 | the honest commitments and responses | A7, A8 |
| Nonce derivation | Thm 6 | "Derivations", the Sigma nonces | A1, A7, A8 |
| Hiding of `V_k` given `Y_k` | Lem 7.1, Thm 7 | "The blinder commitments" | A3, A6, A7, A8 |
| What the lender learns | Thm 7′ | "Liquidation", "The lender rebuilds" | as Thm 5 |
| The lender's search | Thm 8 | "Liquidation", "The lender rebuilds" | as Thm 4 |
| Completeness | Prop 9 | "Installment", the edge tests | none |
| The rebuild leak | L1 | "Never rebuild an index" | none |

## References

- [BN06] M. Bellare, G. Neven. Multi-signatures in the plain public-key model and a general forking
  lemma. CCS 2006.
- [BPW12] D. Bernhard, O. Pereira, B. Warinschi. How not to prove yourself: pitfalls of the
  Fiat–Shamir heuristic and applications to Helios. ASIACRYPT 2012.
- [CDMP05] J.-S. Coron, Y. Dodis, C. Malinaud, P. Puniya. Merkle–Damgård revisited: how to
  construct a hash function. CRYPTO 2005.
- [FKMV12] S. Faust, M. Kohlweiss, G. A. Marson, D. Venturi. On the non-malleability of the
  Fiat–Shamir transform. INDOCRYPT 2012.
- [FPS20] G. Fuchsbauer, A. Plouviez, Y. Seurin. Blind Schnorr signatures and signed ElGamal
  encryption in the algebraic group model. EUROCRYPT 2020.
- [Mau09] U. Maurer. Unifying zero-knowledge proofs of knowledge. AFRICACRYPT 2009.
- [MP15] G. Maxwell, A. Poelstra. Borromean ring signatures. 2015.
- [PBF+18] A. Poelstra, A. Back, M. Friedenbach, G. Maxwell, P. Wuille. Confidential assets.
  Financial Cryptography 2018 workshops.
- [PS00] D. Pointcheval, J. Stern. Security arguments for digital signatures and blind signatures.
  Journal of Cryptology, 2000.
- The spike note, `2026-11-21-phase-7-spike/note.md`, for the Elements and Simplicity sources.
