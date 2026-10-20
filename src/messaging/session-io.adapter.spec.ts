import { toExpressNext } from './session-io.adapter'

// The bridge between express-session's `next` and socket.io's: what each
// call becomes decides whether a socket handshake goes on or is refused.
// `jest.fn<void, [Error?]>()`: the mock typed as socket.io's `next`, so
// reading its calls is checked (an untyped jest.fn() records `any`).
describe('toExpressNext', () => {
  it('lets the handshake go on when the session middleware finishes without an error', () => {
    const next = jest.fn<void, [Error?]>()
    toExpressNext(next)()
    expect(next.mock.calls).toStrictEqual([[]])
  })

  it('passes an Error on as it is — socket.io then refuses the handshake', () => {
    const next = jest.fn<void, [Error?]>()
    const failure = new Error('connection refused')
    toExpressNext(next)(failure)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0][0]).toBe(failure)
  })

  it('wraps anything else in an Error, keeping it as the cause — a failure is never read as success', () => {
    const next = jest.fn<void, [Error?]>()
    toExpressNext(next)('the store is down')
    const [[passed]] = next.mock.calls
    expect(passed).toBeInstanceOf(Error)
    expect(passed?.message).toBe('The session middleware failed')
    expect(passed?.cause).toBe('the store is down')
  })
})
