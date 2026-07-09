import { AIAssistantIndicator, AIAssistantPane } from '@/features/ai-assistant'
import { RailElement } from '@/features/ide-react/util/rail-types'
import getMeta from '@/utils/meta'

const aiAssistantRailEntry: RailElement = {
  key: 'ai-assistant',
  icon: 'smart_toy',
  title: 'AI Assistant',
  component: <AIAssistantPane />,
  indicator: <AIAssistantIndicator />,
  hide: () => {
    const aiEnabled =
      getMeta('ol-capabilities')?.includes('ai-assistant') ?? false
    return !aiEnabled
  },
}

export default aiAssistantRailEntry
