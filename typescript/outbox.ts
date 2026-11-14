import type { World } from "./spread.ts"
import type { Action, ActionResult, Audience, FeeStep, PostAction, StopRef } from "./types.ts"

export type PendingPostMeta = {
  action: PostAction
  isBundledTwoOrder: boolean
  splitAt: number
  urgentEscalated: boolean
  pastDeadlineEscalated: boolean
  endWorldRescueEscalated: boolean
  strippedFallback: boolean
}

const ACTION_PRIORITY: Record<Action["type"], number> = {
  quote: 0,
  withdraw: 1,
  release: 2,
  post: 3,
  reprice: 4,
  offer: 5,
}

export class ActionOutbox {
  readonly actions: Action[] = []
  readonly pendingPostMeta = new WeakMap<PostAction, PendingPostMeta>()

  get length(): number {
    return this.actions.length
  }

  push(action: Action): void {
    this.actions.push(action)
  }

  enqueuePost(
    stops: StopRef[],
    audience: Audience,
    schedule: FeeStep[],
    meta: Omit<PendingPostMeta, "action">,
  ): PostAction {
    const postAction: PostAction = { type: "post", stops, audience, schedule }
    this.pendingPostMeta.set(postAction, { action: postAction, ...meta })
    this.actions.push(postAction)
    return postAction
  }

  getPostMeta(action: PostAction): PendingPostMeta | undefined {
    return this.pendingPostMeta.get(action)
  }

  hasPendingQuote(): boolean {
    return this.actions.some((a) => a.type === "quote")
  }

  hasPendingPostForLeg(orderId: string, leg: number): boolean {
    return this.actions.some(
      (a) => a.type === "post" && a.stops.some((s) => s.kind === "pickup" && s.orderId === orderId && s.leg === leg),
    )
  }

  hasStalePendingReleasePost(orderId: string, leg: number, minFromExclusive: number): boolean {
    return this.actions.some(
      (a) =>
        a.type === "post" &&
        a.stops.some(
          (s) => s.orderId === orderId && s.leg === leg && s.kind === "pickup" && (s.window?.from ?? 0) > minFromExclusive,
        ),
    )
  }

  removePostsForOrder(orderId: string): StopRef[] {
    const displacedOtherPickups: StopRef[] = []
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const act = this.actions[i]!
      if (act.type === "post" && act.stops.some((s) => s.orderId === orderId)) {
        for (const s of act.stops) {
          if (s.orderId !== orderId && s.kind === "pickup") displacedOtherPickups.push(s)
        }
        this.actions.splice(i, 1)
      }
    }
    return displacedOtherPickups
  }

  removeWithdrawForGig(gigId: string): boolean {
    let removed = false
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const act = this.actions[i]!
      if (act.type === "withdraw" && act.gigId === gigId) {
        this.actions.splice(i, 1)
        removed = true
      }
    }
    return removed
  }

  removePostsOverlappingOrders(coveredOrders: ReadonlySet<string>): Set<string> {
    const orphanedOrders = new Set<string>()
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const act = this.actions[i]!
      if (act.type === "post" && act.stops.some((s) => coveredOrders.has(s.orderId))) {
        for (const s of act.stops) {
          if (!coveredOrders.has(s.orderId)) orphanedOrders.add(s.orderId)
        }
        this.actions.splice(i, 1)
      }
    }
    return orphanedOrders
  }

  removePostsOverlappingPickupLegs(
    coveredLegs: ReadonlySet<string>,
    coveredOrders: ReadonlySet<string>,
  ): Set<string> {
    const orphanedPartners = new Set<string>()
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const cand = this.actions[i]!
      if (
        cand.type === "post" &&
        cand.stops.some((s) => s.kind === "pickup" && coveredLegs.has(`${s.orderId}:${s.leg}`))
      ) {
        for (const s of cand.stops) {
          if (s.kind === "pickup" && !coveredOrders.has(s.orderId)) orphanedPartners.add(s.orderId)
        }
        this.actions.splice(i, 1)
      }
    }
    return orphanedPartners
  }

  drainSorted(): Action[] {
    if (this.actions.length === 0) return []
    const drained = this.actions.splice(0)
    drained.sort((a, b) => ACTION_PRIORITY[a.type] - ACTION_PRIORITY[b.type])
    return drained
  }

  private extractByPredicate(pred: (a: Action) => boolean): Action[] {
    const extracted: Action[] = []
    for (let i = this.actions.length - 1; i >= 0; i--) {
      if (pred(this.actions[i]!)) {
        extracted.push(this.actions.splice(i, 1)[0]!)
      }
    }
    extracted.reverse()
    return extracted
  }

  async sendQuotesOnly(
    world: World,
    onResults: (sent: readonly Action[], results: readonly ActionResult[]) => void,
  ): Promise<void> {
    const quotes = this.extractByPredicate((a) => a.type === "quote")
    for (let i = 0; i < quotes.length; i += 20) {
      const chunk = quotes.slice(i, i + 20)
      const res = await world.act(chunk)
      onResults(chunk, res)
    }
  }

  async send(
    world: World,
    isFinal: boolean,
    onResults: (sent: readonly Action[], results: readonly ActionResult[]) => void,
  ): Promise<void> {
    if (this.actions.length === 0) return
    if (!isFinal) {
      const hasCancel = this.actions.some((a) => a.type === "withdraw" || a.type === "release")
      const hasPost = this.actions.some((a) => a.type === "post")
      if (!hasCancel || !hasPost) {
        const sorted = this.drainSorted()
        if (sorted.length > 0) {
          const results = await world.act(sorted)
          onResults(sorted, results)
        }
        return
      }
    }

    await this.sendQuotesOnly(world, onResults)

    const cancels = this.extractByPredicate((a) => a.type === "withdraw" || a.type === "release")
    if (cancels.length > 0) {
      const res = await world.act(cancels)
      onResults(cancels, res)
    }

    const rest = this.drainSorted()
    if (!isFinal) {
      if (rest.length > 0) {
        const res = await world.act(rest)
        onResults(rest, res)
      }
    } else {
      for (let i = 0; i < rest.length; i += 15) {
        if (this.hasPendingQuote()) {
          await this.sendQuotesOnly(world, onResults)
        }
        const chunk = rest.slice(i, i + 15)
        const res = await world.act(chunk)
        onResults(chunk, res)
      }
    }
  }
}
