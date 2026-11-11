"""Guillotine ("chop") league maths: who gets chopped, what a free agent is worth,
and what it takes to win him at the weekly blind auction.

Everything here is plain numpy on plain dataclasses, so it runs and is tested
without a database. `league.bids` loads the league from Postgres and stores the
result.

What it does, in order:
1. Every player gets a weekly points level for the rest of the season: this
   week's projection when there is one, otherwise recent form; zero in weeks he
   cannot play (bye, injured reserve).
2. Each team's best legal lineup per week gives a team mean and spread.
3. The season is simulated: each week the lowest score among the teams still
   alive is chopped. → every team's chance of going out this week and of
   winning the league.
4. A free agent's value to a team = the change in those odds when he is added,
   on the same simulated seasons (common random numbers).
5. What rivals will bid is drawn from how each of them has bid before, as a
   share of the money they had at the time, scaled by how much the player would
   improve *their* lineup, and capped by what they have left.

Known simplifications (see docs/league/guillotine.md): future weeks reuse one
level per player (no matchup effects), chopped players are not redistributed
inside the simulation, and scores of different teams are independent.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

FLEX_SLOTS = {
    "FLEX": ("RB", "WR", "TE"),
    "WRRB_FLEX": ("RB", "WR"),
    "REC_FLEX": ("WR", "TE"),
    "SUPER_FLEX": ("QB", "RB", "WR", "TE"),
}
BENCH_SLOTS = {"BN", "IR", "TAXI"}
LONG_TERM = {"IR", "PUP", "NFI", "COV", "Inactive", "Injured Reserve", "Physically Unable to Perform"}
THIS_WEEK = {"Out", "Doubtful", "Sus", "Suspended", "DNR"}


@dataclass
class Player:
    pid: str                          # sleeper id
    name: str
    pos: str
    team: str | None = None
    proj: float | None = None         # this week's projected points (None = not projected)
    proj_sd: float | None = None
    avg: float | None = None          # season average
    recent: float | None = None       # last four weeks
    games: int = 0
    status: str | None = None         # Sleeper injury status
    roster_status: str | None = None  # Sleeper roster status (Active / Inactive / …)

    @property
    def level(self) -> float:
        """Points a week when he plays, matchup-neutral."""
        form = None
        if self.avg is not None and self.games >= 3:
            form = 0.6 * self.avg + 0.4 * (self.recent if self.recent is not None else self.avg)
        if self.proj is not None and form is not None:
            return 0.5 * self.proj + 0.5 * form
        if self.proj is not None:
            return self.proj
        if form is not None:
            return form
        return self.avg or 0.0

    def sd(self, mean: float) -> float:
        if self.proj_sd is not None and self.proj and abs(mean - self.proj) < 1e-9:
            return self.proj_sd
        return 4.0 + 0.31 * mean if mean > 0 else 0.0          # fitted to the projection spreads


@dataclass
class Team:
    roster_id: int
    owner: str
    budget: float
    players: list[Player]
    is_me: bool = False


@dataclass
class Bid:
    week: int
    roster_id: int
    pid: str
    amount: float
    won: bool
    budget_before: float | None = None


@dataclass
class League:
    week: int                                   # the week about to be played
    last_week: int                              # last week a team is chopped
    slots: list[str]                            # roster_positions, e.g. QB RB RB WR WR TE FLEX FLEX BN…
    teams: list[Team]                           # teams still alive
    free_agents: list[Player]
    bids: list[Bid] = field(default_factory=list)
    byes: dict[str, set[int]] = field(default_factory=dict)   # team → weeks without a game
    ir_games: int = 4

    @property
    def me(self) -> Team:
        return next(t for t in self.teams if t.is_me)

    @property
    def weeks(self) -> list[int]:
        return list(range(self.week, self.last_week + 1))[: max(len(self.teams) - 1, 1)]


# ---------------------------------------------------------------------------
# players → weekly means
# ---------------------------------------------------------------------------
def weekly_means(lg: League, p: Player) -> np.ndarray:
    """Expected points in each remaining week (0 when he cannot play)."""
    weeks = lg.weeks
    out = np.zeros(len(weeks))
    byes = lg.byes.get(p.team or "", set())
    long_term = (p.status in LONG_TERM) or (p.roster_status in LONG_TERM)
    missed = 0
    for i, w in enumerate(weeks):
        if w in byes:
            continue
        if long_term and missed < lg.ir_games:
            missed += 1
            continue
        if i == 0:
            if p.status in THIS_WEEK:
                continue
            # the projection model is the authority on who plays this week
            out[i] = p.proj if p.proj is not None else 0.0
        else:
            out[i] = p.level
    return out


def _sd_row(p: Player, means: np.ndarray) -> np.ndarray:
    return np.array([p.sd(m) for m in means])


def best_lineup(pos: list[str], mean: np.ndarray, slots: list[str]) -> list[int]:
    """Indices of the highest-mean legal lineup (dedicated slots first, then flex)."""
    order = np.argsort(-mean)
    used: list[int] = []
    taken = set()
    for s in slots:
        if s in BENCH_SLOTS or s in FLEX_SLOTS:
            continue
        for i in order:
            if i not in taken and pos[i] == s:
                taken.add(i)
                used.append(int(i))
                break
    for s in slots:
        if s not in FLEX_SLOTS:
            continue
        for i in order:
            if i not in taken and pos[i] in FLEX_SLOTS[s]:
                taken.add(i)
                used.append(int(i))
                break
    return used


def team_curve(lg: League, players: list[Player]) -> tuple[np.ndarray, np.ndarray]:
    """→ (mean, sd) of the team's best lineup for each remaining week."""
    n = len(lg.weeks)
    if not players:
        return np.zeros(n), np.ones(n)
    means = np.vstack([weekly_means(lg, p) for p in players])           # player × week
    sds = np.vstack([_sd_row(p, m) for p, m in zip(players, means, strict=True)])
    pos = [p.pos for p in players]
    mu, sd = np.zeros(n), np.zeros(n)
    for w in range(n):
        idx = best_lineup(pos, means[:, w], lg.slots)
        mu[w] = means[idx, w].sum()
        sd[w] = np.sqrt((sds[idx, w] ** 2).sum()) or 1.0
    return mu, sd


# ---------------------------------------------------------------------------
# season simulation
# ---------------------------------------------------------------------------
@dataclass
class Odds:
    chop_now: np.ndarray      # per team: chance of being chopped this week
    win: np.ndarray           # per team: chance of being the last one alive
    chop_week: np.ndarray     # team × week: chance of being chopped in that week
    weeks_alive: np.ndarray   # per team: expected number of weeks survived


def simulate(mu: np.ndarray, sd: np.ndarray, z: np.ndarray) -> Odds:
    """mu, sd: team × week. z: sim × week × team standard normals (reuse the same
    z to compare rosters). Each week the lowest score among live teams goes."""
    n_team, n_week = mu.shape
    n_sim = z.shape[0]
    alive = np.ones((n_sim, n_team), dtype=bool)
    chop_week = np.zeros((n_team, n_week))
    rows = np.arange(n_sim)
    for w in range(n_week):
        if w >= n_team - 1:
            break
        score = mu[:, w][None, :] + sd[:, w][None, :] * z[:, w, :]
        score = np.where(alive, score, np.inf)
        out = score.argmin(axis=1)
        alive[rows, out] = False
        chop_week[:, w] = np.bincount(out, minlength=n_team) / n_sim
    left = alive.sum(axis=1)
    win = (alive / left[:, None]).mean(axis=0)            # ties in survival share the title
    weeks_alive = n_week - (chop_week * (n_week - np.arange(n_week))[None, :]).sum(axis=1)
    return Odds(chop_week[:, 0], win, chop_week, weeks_alive)


def draws(n_sim: int, n_week: int, n_team: int, seed: int = 7) -> np.ndarray:
    return np.random.default_rng(seed).standard_normal((n_sim, n_week, n_team))


# ---------------------------------------------------------------------------
# rival bids
# ---------------------------------------------------------------------------
def prize_fractions(lg: League, top_n: int = 3, min_bid: float = 20.0) -> tuple[dict[int, list[float]], list[float]]:
    """For each past waiver run: the share of its money each team put on that
    week's prizes (the `top_n` players by highest bid). A team that had money
    and bid on none of them counts as 0. → ({roster_id: [fractions]}, pooled).

    Only weeks with a real prize (highest bid ≥ `min_bid`) count."""
    by_week: dict[int, list[Bid]] = {}
    for b in lg.bids:
        by_week.setdefault(b.week, []).append(b)
    per_team: dict[int, list[float]] = {}
    pooled: list[float] = []
    for bids in by_week.values():
        top: dict[str, float] = {}
        for b in bids:
            top[b.pid] = max(top.get(b.pid, 0.0), b.amount)
        prizes = [pid for pid, amt in sorted(top.items(), key=lambda kv: -kv[1])[:top_n] if amt >= min_bid]
        if not prizes:
            continue
        bidders = {b.roster_id for b in bids}
        for rid in bidders:
            mine = [b for b in bids if b.roster_id == rid]
            budget = max((b.budget_before or 0.0) for b in mine)
            if budget <= 0:
                continue
            best = max((b.amount for b in mine if b.pid in prizes), default=0.0)
            f = min(best / budget, 1.0)
            per_team.setdefault(rid, []).append(f)
            pooled.append(f)
    return per_team, pooled


def rival_bid_samples(
    lg: League, gains: dict[int, np.ndarray], n: int = 4000, seed: int = 11, shrink: float = 3.0,
) -> dict[int, np.ndarray]:
    """Simulated bids of each rival on each candidate. gains[roster_id] = that
    team's lineup gain per candidate (points a week). → {roster_id: n × candidates}.

    A rival puts its 'prize share' (drawn from its own history, shrunk towards
    the league's) on the candidate that helps it most, proportionally less on
    the others, nothing on a player who does not improve its lineup, and never
    more than it has."""
    rng = np.random.default_rng(seed)
    per_team, pooled = prize_fractions(lg)
    pooled_arr = np.array(pooled) if pooled else np.array([0.25])
    out: dict[int, np.ndarray] = {}
    for t in lg.teams:
        if t.is_me:
            continue
        g = np.maximum(gains[t.roster_id], 0.0)
        own = np.array(per_team.get(t.roster_id, []))
        w_own = len(own) / (len(own) + shrink)
        use_own = (rng.random(n) < w_own) & (len(own) > 0)
        f = np.where(use_own, rng.choice(own, n) if len(own) else 0.0, rng.choice(pooled_arr, n))
        f = f * rng.lognormal(0.0, 0.2, n)
        rel = g / g.max() if g.max() > 0.75 else np.zeros_like(g)        # under ¾ pt a week: not a target
        bids = t.budget * np.clip(f, 0, 1)[:, None] * rel[None, :]
        out[t.roster_id] = np.minimum(bids, t.budget)
    return out


def price_ladder(samples: dict[int, np.ndarray], col: int, qs=(0.5, 0.8, 0.95)) -> list[int]:
    """Smallest whole-dollar bids that beat every rival in q of the simulations."""
    top = np.max(np.vstack([s[:, col] for s in samples.values()]), axis=0)
    return [int(np.floor(np.quantile(top, q))) + 1 for q in qs]


def win_prob(samples: dict[int, np.ndarray], col: int, bid: float) -> float:
    top = np.max(np.vstack([s[:, col] for s in samples.values()]), axis=0)
    return float((top < bid).mean())


# ---------------------------------------------------------------------------
# the weekly answer
# ---------------------------------------------------------------------------
@dataclass
class Rec:
    player: Player
    level: float
    gain_now: float            # lineup points added this week
    gain_avg: float            # … per week over the rest of the season
    d_chop: float              # change in my chance of being chopped this week (negative = safer)
    d_win: float               # change in my chance of winning the league
    bid_50: int
    bid_80: int
    bid_95: int
    bid: int = 0               # recommended bid (0 = do not bid)
    win_at_bid: float = 0.0
    top_rivals: list[tuple[str, int]] = field(default_factory=list)   # (owner, median simulated bid)
    beats_all_but: list[str] = field(default_factory=list)            # rivals whose budget exceeds the bid
    group: str | None = None   # recs in one group share a drop: at most one of them should win
    drop: str | None = None


@dataclass
class Result:
    league: League
    odds: Odds
    team_mean: np.ndarray       # this week's lineup mean per team
    recs: list[Rec]
    dollar_value: float         # lineup points a dollar kept is expected to buy later
    drops: list[tuple[Player, float]]      # my least valuable players: (player, points a week lost without him)


def recommend(lg: League, n_sim: int = 20000, max_candidates: int = 24, seed: int = 7) -> Result:
    weeks = lg.weeks
    n_week, n_team = len(weeks), len(lg.teams)
    curves = [team_curve(lg, t.players) for t in lg.teams]
    mu = np.vstack([c[0] for c in curves])
    sd = np.vstack([c[1] for c in curves])
    z = draws(n_sim, n_week, n_team, seed)
    base = simulate(mu, sd, z)
    me_i = next(i for i, t in enumerate(lg.teams) if t.is_me)
    me = lg.teams[me_i]

    # candidates: the free agents that would add the most to my lineup, plus the best overall
    cands = sorted(lg.free_agents, key=lambda p: -max(p.level, p.proj or 0.0))[: max_candidates * 2]
    scored = []
    for p in cands:
        m2, s2 = team_curve(lg, me.players + [p])
        scored.append((p, m2, s2, float((m2 - mu[me_i]).mean())))
    scored.sort(key=lambda x: -x[3])
    scored = [s for s in scored if s[3] > 0.05][:max_candidates]
    cand_players = [s[0] for s in scored]

    # what each candidate is worth to each rival (drives their bids)
    gains: dict[int, np.ndarray] = {}
    for i, t in enumerate(lg.teams):
        if t.is_me:
            continue
        gains[t.roster_id] = np.array(
            [float((team_curve(lg, t.players + [p])[0] - mu[i]).mean()) for p in cand_players]
        )
    samples = rival_bid_samples(lg, gains, seed=seed + 4) if len(lg.teams) > 1 and cand_players else {}

    recs: list[Rec] = []
    for col, (p, m2, s2, gain_avg) in enumerate(scored):
        mu2, sd2 = mu.copy(), sd.copy()
        mu2[me_i], sd2[me_i] = m2, s2
        o = simulate(mu2, sd2, z)
        b50, b80, b95 = price_ladder(samples, col) if samples else (1, 1, 1)
        rivals = sorted(
            ((t.owner, int(np.median(samples[t.roster_id][:, col]))) for t in lg.teams if not t.is_me),
            key=lambda kv: -kv[1],
        )[:3] if samples else []
        recs.append(Rec(
            player=p, level=p.level, gain_now=float(m2[0] - mu[me_i, 0]), gain_avg=gain_avg,
            d_chop=float(o.chop_now[me_i] - base.chop_now[me_i]), d_win=float(o.win[me_i] - base.win[me_i]),
            bid_50=b50, bid_80=b80, bid_95=b95, top_rivals=[r for r in rivals if r[1] > 0],
        ))
    recs.sort(key=lambda r: -(r.d_win - 0.5 * r.d_chop))

    dollar = _dollar_value(lg, base, mu, me_i)
    drops = _drop_order(lg, me, mu[me_i])
    _assign_bids(lg, me, recs, samples, cand_players, dollar, n_week, drops)
    return Result(lg, base, mu[:, 0], recs, dollar, drops)


def _dollar_value(lg: League, base: Odds, mu: np.ndarray, me_i: int) -> float:
    """What a dollar kept is worth, in lineup points: the value expected in later
    pools (each rival's best players, weighted by the chance that team is the
    one chopped, by the weeks left to use them and by my still being alive),
    spread over my budget. A rule of thumb: it assumes my money buys later
    prizes at the rate it buys them now and ignores who else bids then."""
    n_week = mu.shape[1]
    me = lg.teams[me_i]
    if me.budget <= 0:
        return 0.0
    future = 0.0
    for i, t in enumerate(lg.teams):
        if i == me_i or not t.players:
            continue
        best = sorted(t.players, key=lambda p: -p.level)[:3]
        g = max(float((team_curve(lg, me.players + [p])[0] - mu[me_i]).mean()) for p in best)
        for w in range(n_week - 1):
            alive = 1.0 - base.chop_week[me_i, : w + 1].sum()
            future += base.chop_week[i, w] * max(g, 0.0) * (n_week - 1 - w) * alive
    return future / me.budget


def _drop_order(lg: League, me: Team, base_mu: np.ndarray) -> list[tuple[Player, float]]:
    out = []
    for p in me.players:
        rest = [q for q in me.players if q is not p]
        loss = float((base_mu - team_curve(lg, rest)[0]).mean())
        out.append((p, loss))
    return sorted(out, key=lambda x: (x[1], x[0].level))


def best_bid(top: np.ndarray, value: float, dollar: float, limit: float, budgets: list[float]) -> tuple[int, float]:
    """The bid that maximises  P(win at b) x (value - dollar x b)  against the
    simulated highest rival bid `top`. Candidates: whole dollars on a grid plus
    one dollar over each rival's entire budget (a certain win against that rival)."""
    grid = set(range(1, int(limit) + 1, max(int(limit) // 200, 1)))
    grid |= {int(b) + 1 for b in budgets if b + 1 <= limit}
    best, best_ev, best_p = 0, 0.0, 0.0
    srt = np.sort(top)
    for b in sorted(grid):
        p = float(np.searchsorted(srt, b, side="left") / len(srt))
        ev = p * (value - dollar * b)
        if ev > best_ev + 1e-12:
            best, best_ev, best_p = b, ev, p
    return best, best_p


def _assign_bids(lg, me, recs, samples, cand_players, dollar, n_week, drops) -> None:
    """Primary target: the value-maximising bid. One alternative at the same
    position shares the drop (either/or). One player at another position gets a
    bid from what is left. Everything else gets none."""
    if not recs or not samples:
        return
    col = {p.pid: i for i, p in enumerate(cand_players)}
    rivals = [t for t in lg.teams if not t.is_me]
    budgets = [t.budget for t in rivals]

    def top(r: Rec) -> np.ndarray:
        return np.max(np.vstack([s[:, col[r.player.pid]] for s in samples.values()]), axis=0)

    def finish(r: Rec, limit: float, group: str, drop: Player | None) -> None:
        amount, p = best_bid(top(r), r.gain_avg * n_week, dollar, limit, budgets)
        if amount <= 0:
            return
        r.bid, r.win_at_bid = amount, p
        r.beats_all_but = [t.owner for t in rivals if t.budget >= amount]
        r.group, r.drop = group, drop.name if drop else None

    first = recs[0]
    drop1 = drops[0][0] if drops else None
    finish(first, me.budget, "A", drop1)
    alt = next((r for r in recs[1:] if r.player.pos == first.player.pos and r.gain_avg > 0.5 * first.gain_avg), None)
    if alt is not None and first.bid:
        finish(alt, first.bid, "A", drop1)
    left = me.budget - first.bid
    other = next((r for r in recs[1:] if r is not alt and r.player.pos != first.player.pos and r.gain_avg > 1.0), None)
    if other is not None and len(drops) > 1 and left > 0:
        finish(other, left, "B", drops[1][0])
        if other.win_at_bid < 0.25:            # a bid that rarely wins is noise
            other.bid, other.win_at_bid, other.group, other.drop, other.beats_all_but = 0, 0.0, None, None, []
