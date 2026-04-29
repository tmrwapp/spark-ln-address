import { FLASHNET_ORDER_STATUS } from './flashnet-order-status'
import { classifyTransition, validateTransition, mapEventToStatus } from './swap-state-machine'
const {
  PENDING_PAYMENT,
  PROCESSING,
  CONFIRMING,
  SWAPPING,
  DELIVERING,
  DELIVERED,
  FAILED,
  REFUNDING,
  REFUNDED,
} = FLASHNET_ORDER_STATUS

describe('validateTransition', () => {
  describe('legal transitions', () => {
    it('PENDING_PAYMENT → PROCESSING', () => {
      expect(validateTransition(PENDING_PAYMENT, PROCESSING)).toBe(PROCESSING)
    })

    it('PROCESSING → CONFIRMING', () => {
      expect(validateTransition(PROCESSING, CONFIRMING)).toBe(CONFIRMING)
    })

    it('CONFIRMING → SWAPPING', () => {
      expect(validateTransition(CONFIRMING, SWAPPING)).toBe(SWAPPING)
    })

    it('SWAPPING → DELIVERING', () => {
      expect(validateTransition(SWAPPING, DELIVERING)).toBe(DELIVERING)
    })

    it('DELIVERING → DELIVERED (happy path)', () => {
      expect(validateTransition(DELIVERING, DELIVERED)).toBe(DELIVERED)
    })

    it('DELIVERING → FAILED (delivery failure)', () => {
      expect(validateTransition(DELIVERING, FAILED)).toBe(FAILED)
    })

    it('PROCESSING → REFUNDING (slippage breach early)', () => {
      expect(validateTransition(PROCESSING, REFUNDING)).toBe(REFUNDING)
    })

    it('SWAPPING → REFUNDING (slippage breach late)', () => {
      expect(validateTransition(SWAPPING, REFUNDING)).toBe(REFUNDING)
    })

    it('REFUNDING → REFUNDED', () => {
      expect(validateTransition(REFUNDING, REFUNDED)).toBe(REFUNDED)
    })

    // Docs-supported edges that older code rejected; coverage guards regression.
    it('PROCESSING → DELIVERED (fast-path completion is documented)', () => {
      expect(validateTransition(FLASHNET_ORDER_STATUS.PROCESSING, DELIVERED)).toBe(DELIVERED)
    })

    it('CONFIRMING → DELIVERING (skips swapping for some routes)', () => {
      expect(validateTransition(CONFIRMING, DELIVERING)).toBe(DELIVERING)
    })

    it('CONFIRMING → FAILED (terminal failure from confirming)', () => {
      expect(validateTransition(CONFIRMING, FAILED)).toBe(FAILED)
    })

    it('SWAPPING → BRIDGING (router can re-bridge after swap)', () => {
      expect(validateTransition(SWAPPING, FLASHNET_ORDER_STATUS.BRIDGING)).toBe(
        FLASHNET_ORDER_STATUS.BRIDGING,
      )
    })

    it('DELIVERING → REFUNDING (delivery breach triggers refund)', () => {
      expect(validateTransition(DELIVERING, REFUNDING)).toBe(REFUNDING)
    })

    it('UNFULFILLED → DELIVERED (recovery from unfulfilled is documented)', () => {
      expect(validateTransition(FLASHNET_ORDER_STATUS.UNFULFILLED, DELIVERED)).toBe(DELIVERED)
    })

    it('PAUSED → PROCESSING (resume after pause)', () => {
      expect(validateTransition(FLASHNET_ORDER_STATUS.PAUSED, PROCESSING)).toBe(PROCESSING)
    })
  })

  describe('illegal transitions', () => {
    it('DELIVERED → FAILED throws', () => {
      expect(() => validateTransition(DELIVERED, FAILED)).toThrow(
        'Illegal state transition: "DELIVERED" → "FAILED"',
      )
    })

    it('DELIVERED → PROCESSING throws (terminal is terminal)', () => {
      expect(() => validateTransition(DELIVERED, PROCESSING)).toThrow()
    })

    it('FAILED → DELIVERING throws', () => {
      expect(() => validateTransition(FAILED, DELIVERING)).toThrow()
    })

    it('REFUNDED → REFUNDING throws', () => {
      expect(() => validateTransition(REFUNDED, REFUNDING)).toThrow()
    })

    it('PENDING_PAYMENT → DELIVERED (skip states) throws', () => {
      expect(() => validateTransition(PENDING_PAYMENT, DELIVERED)).toThrow()
    })

    it('EXPIRED → PROCESSING throws (terminal)', () => {
      expect(() => validateTransition(FLASHNET_ORDER_STATUS.EXPIRED, PROCESSING)).toThrow()
    })

    it('PAUSED → DELIVERED throws (PAUSED only resumes to PROCESSING or fails)', () => {
      expect(() => validateTransition(FLASHNET_ORDER_STATUS.PAUSED, DELIVERED)).toThrow()
    })

    it('unknown current state throws', () => {
      expect(() => validateTransition('UNKNOWN_STATE' as any, PROCESSING)).toThrow(
        'Unknown current state: "UNKNOWN_STATE"',
      )
    })
  })
})

describe('mapEventToStatus', () => {
  it('maps order.processing → PROCESSING', () => {
    expect(mapEventToStatus('order.processing')).toBe(PROCESSING)
  })

  it('maps order.confirming → CONFIRMING', () => {
    expect(mapEventToStatus('order.confirming')).toBe(CONFIRMING)
  })

  it('maps order.swapping → SWAPPING', () => {
    expect(mapEventToStatus('order.swapping')).toBe(SWAPPING)
  })

  it('maps order.delivering → DELIVERING', () => {
    expect(mapEventToStatus('order.delivering')).toBe(DELIVERING)
  })

  it('maps order.completed → DELIVERED', () => {
    expect(mapEventToStatus('order.completed')).toBe(DELIVERED)
  })

  it('maps order.failed → FAILED', () => {
    expect(mapEventToStatus('order.failed')).toBe(FAILED)
  })

  it('maps order.refunding → REFUNDING', () => {
    expect(mapEventToStatus('order.refunding')).toBe(REFUNDING)
  })

  it('maps order.refunded → REFUNDED', () => {
    expect(mapEventToStatus('order.refunded')).toBe(REFUNDED)
  })

  it('maps order.bridging → BRIDGING', () => {
    expect(mapEventToStatus('order.bridging')).toBe(FLASHNET_ORDER_STATUS.BRIDGING)
  })

  it('maps order.awaiting_approval → AWAITING_APPROVAL', () => {
    expect(mapEventToStatus('order.awaiting_approval')).toBe(
      FLASHNET_ORDER_STATUS.AWAITING_APPROVAL,
    )
  })

  it('maps order.unfulfilled → UNFULFILLED', () => {
    expect(mapEventToStatus('order.unfulfilled')).toBe(FLASHNET_ORDER_STATUS.UNFULFILLED)
  })

  it('throws on unknown event name', () => {
    expect(() => mapEventToStatus('order.unknown')).toThrow(
      'Unknown Flashnet webhook event: "order.unknown"',
    )
  })

  it('throws with correct message format for unknown event', () => {
    expect(() => mapEventToStatus('order.mystery_event')).toThrow(
      'Unknown Flashnet webhook event: "order.mystery_event"',
    )
  })
})

// ---------------------------------------------------------------------------
// PR6 additions — additional edge-case coverage
// ---------------------------------------------------------------------------

describe('validateTransition — error message content', () => {
  it('illegal transition error message lists allowed next states', () => {
    // PENDING_PAYMENT only allows → PROCESSING; error should include "PROCESSING"
    expect(() => validateTransition(PENDING_PAYMENT, SWAPPING)).toThrow(PROCESSING)
  })

  it('terminal state transition error says "none" for allowed states', () => {
    // DELIVERED is terminal — no outbound transitions
    let caught: Error | undefined
    try {
      validateTransition(DELIVERED, PROCESSING)
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toContain('none')
  })

  it('FAILED terminal state rejects any transition with "none" in allowed list', () => {
    let caught: Error | undefined
    try {
      validateTransition(FAILED, PROCESSING)
    } catch (e) {
      caught = e as Error
    }
    expect(caught!.message).toContain('none')
  })

  it('REFUNDED terminal state rejects any transition with "none" in allowed list', () => {
    let caught: Error | undefined
    try {
      validateTransition(REFUNDED, PROCESSING)
    } catch (e) {
      caught = e as Error
    }
    expect(caught!.message).toContain('none')
  })
})

describe('classifyTransition', () => {
  it('apply: legal forward transition returns kind="apply" with next state', () => {
    expect(classifyTransition(PROCESSING, FLASHNET_ORDER_STATUS.CONFIRMING)).toEqual({
      kind: 'apply',
      next: FLASHNET_ORDER_STATUS.CONFIRMING,
    })
  })

  it('noop: redelivery of the same status returns kind="noop"', () => {
    expect(classifyTransition(PROCESSING, PROCESSING)).toEqual({
      kind: 'noop',
      reason: 'idempotent_redelivery',
    })
  })

  it('noop: redelivery on a terminal state returns kind="noop" (not skip)', () => {
    expect(classifyTransition(DELIVERED, DELIVERED)).toEqual({
      kind: 'noop',
      reason: 'idempotent_redelivery',
    })
  })

  it('skip: out-of-order delivery after terminal returns kind="skip"', () => {
    const decision = classifyTransition(DELIVERED, FLASHNET_ORDER_STATUS.DELIVERING)
    expect(decision.kind).toBe('skip')
    if (decision.kind === 'skip') {
      expect(decision.reason).toBe('stale_or_invalid')
      expect(decision.allowed).toEqual([])
    }
  })

  it('skip: backwards transition (PROCESSING ← DELIVERING) returns kind="skip" with allowed list', () => {
    const decision = classifyTransition(FLASHNET_ORDER_STATUS.DELIVERING, PROCESSING)
    expect(decision.kind).toBe('skip')
    if (decision.kind === 'skip') {
      expect(decision.allowed).toContain(FLASHNET_ORDER_STATUS.DELIVERED)
    }
  })

  it('throws on unknown current state (programming error, not a stale event)', () => {
    expect(() =>
      classifyTransition('UNKNOWN_STATE' as any, PROCESSING),
    ).toThrow('Unknown current state: "UNKNOWN_STATE"')
  })
})
