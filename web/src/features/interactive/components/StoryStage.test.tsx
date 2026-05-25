import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StoryStage } from './StoryStage'
import { abortInteractiveChat, sendInteractiveMessage } from '../api'
import type { InteractiveSSEEvent } from '../types'

vi.mock('../api', () => ({
  abortInteractiveChat: vi.fn(),
  sendInteractiveMessage: vi.fn(),
}))

function streamEvents(events: InteractiveSSEEvent[]): ReadableStream<InteractiveSSEEvent> {
  return new ReadableStream<InteractiveSSEEvent>({
    start(controller) {
      for (const event of events) controller.enqueue(event)
      controller.close()
    },
  })
}

describe('StoryStage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses chat messages for interactive history and streamed agent events', async () => {
    vi.mocked(sendInteractiveMessage).mockResolvedValue(streamEvents([
      { event: 'thinking', data: JSON.stringify({ content: '先判断现场风险。' }) },
      { event: 'chunk', data: JSON.stringify({ content: '<NARRATIVE>火光照亮了' }) },
      { event: 'chunk', data: JSON.stringify({ content: '墙上的新线索。</NARRATIVE><STATE' }) },
      { event: 'chunk', data: JSON.stringify({ content: '_DELTA>{"ops":[{"op":"set","path":"on_stage","value":["林川"]}]}</STATE_DELTA>' }) },
      { event: 'done', data: '{}' },
    ]))
    const onDone = vi.fn()

    render(
      <StoryStage
        storyId="st_1"
        branchId="main"
        snapshot={{
          story_id: 'st_1',
          branch_id: 'main',
          state: {},
          turns: [
            {
              id: 'ev_1',
              parent_id: null,
              branch_id: 'main',
              ts: '',
              user: '我推开酒馆的门',
              narrative: '门后传来低沉的风声。',
            },
          ],
        }}
        onDone={onDone}
      />,
    )

    expect(screen.getAllByText('Nova').length).toBeGreaterThan(0)
    expect(screen.getByText('我推开酒馆的门')).toBeInTheDocument()
    expect(screen.getByText('门后传来低沉的风声。')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('你要做什么？'), { target: { value: '我点燃火把' } })
    fireEvent.click(screen.getByRole('button', { name: /发送/ }))

    await screen.findByText('我点燃火把')
    await screen.findByText('先判断现场风险。')
    await screen.findByText(/火光照亮了墙上的新线索。/)
    expect(screen.queryByText(/STATE_DELTA/)).not.toBeInTheDocument()
    expect(screen.queryByText(/on_stage/)).not.toBeInTheDocument()
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('sends with Enter and keeps Shift+Enter for newline', async () => {
    vi.mocked(sendInteractiveMessage).mockResolvedValue(streamEvents([{ event: 'done', data: '{}' }]))

    render(
      <StoryStage
        storyId="st_1"
        branchId="main"
        snapshot={{ story_id: 'st_1', branch_id: 'main', state: {}, turns: [] }}
        onDone={vi.fn()}
      />,
    )

    const input = screen.getByPlaceholderText('你要做什么？')
    fireEvent.change(input, { target: { value: '第一行' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(sendInteractiveMessage).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(sendInteractiveMessage).toHaveBeenCalledTimes(1))
  })

  it('can abort a running interactive agent output', async () => {
    vi.mocked(sendInteractiveMessage).mockResolvedValue(new ReadableStream<InteractiveSSEEvent>())

    render(
      <StoryStage
        storyId="st_1"
        branchId="main"
        snapshot={{ story_id: 'st_1', branch_id: 'main', state: {}, turns: [] }}
        onDone={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('你要做什么？'), { target: { value: '继续探索' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByRole('button', { name: '中断 AI 执行' })
    fireEvent.click(screen.getByRole('button', { name: '中断 AI 执行' }))

    await waitFor(() => expect(abortInteractiveChat).toHaveBeenCalledTimes(1))
  })
})
