import { maskEmail } from './mask-email'

// The new address as the OLD inbox sees it (decisions §12): the first
// character of each part and the domain's last label, nothing else.
describe('maskEmail', () => {
  it.each([
    ['pat.smith@gmail.com', 'p•••@g•••.com'],
    ['jo@mail.stride.test', 'j•••@m•••.test'],
    ['a@localhost', 'a•••@l•••'],
    // The part before the @ may itself hold an @ when quoted; the domain is
    // what follows the LAST one.
    ['"x@y"@example.org', '"•••@e•••.org'],
  ])('masks %s as %s', (email, masked) => {
    expect(maskEmail(email)).toBe(masked)
  })

  // The mask is the same length whatever is hidden: it says nothing about
  // how long the address is.
  it('hides the length of what it hides', () => {
    expect(maskEmail('p@gmail.com')).toBe(maskEmail('patricia.smith@gmail.com'))
  })

  it('keeps a whole character outside the Basic Multilingual Plane', () => {
    expect(maskEmail('😀pat@x.com')).toBe('😀•••@x•••.com')
  })

  it('masks a value without an @ whole', () => {
    expect(maskEmail('patsmith')).toBe('p•••')
    expect(maskEmail('@x.com')).toBe('@•••')
  })
})
