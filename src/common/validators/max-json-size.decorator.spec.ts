import { validate } from 'class-validator'
import { MaxJsonSize } from './max-json-size.decorator'

class TestPayloadDto {
  @MaxJsonSize(50)
  data: unknown
}

describe('MaxJsonSize', () => {
  it('passes when the serialized value is within the byte limit', async () => {
    const dto = new TestPayloadDto()
    dto.data = { a: 1 }

    const errors = await validate(dto)

    expect(errors).toHaveLength(0)
  })

  it('passes when the serialized value is exactly at the byte limit', async () => {
    const dto = new TestPayloadDto()
    // {"a":"..."} — hand-sized so JSON.stringify comes out to exactly 50 bytes.
    dto.data = { a: 'x'.repeat(42) }
    expect(Buffer.byteLength(JSON.stringify(dto.data), 'utf8')).toBe(50)

    const errors = await validate(dto)

    expect(errors).toHaveLength(0)
  })

  it('fails when the serialized value exceeds the byte limit', async () => {
    const dto = new TestPayloadDto()
    dto.data = { a: 'x'.repeat(100) }

    const errors = await validate(dto)

    expect(errors).toHaveLength(1)
    expect(errors[0].constraints).toHaveProperty('maxJsonSize')
  })

  it('reports the property name and configured limit in the default message', async () => {
    const dto = new TestPayloadDto()
    dto.data = { a: 'x'.repeat(100) }

    const errors = await validate(dto)

    expect(errors[0].constraints?.maxJsonSize).toBe(
      'data must not exceed 50 bytes when serialized as JSON',
    )
  })

  it('fails rather than throwing on a value that cannot be serialized at all', async () => {
    const dto = new TestPayloadDto()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    dto.data = circular

    const errors = await validate(dto)

    expect(errors).toHaveLength(1)
    expect(errors[0].constraints).toHaveProperty('maxJsonSize')
  })
})
