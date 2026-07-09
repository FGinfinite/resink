type StoryComponent = React.ComponentType<Record<string, unknown>>
type Decorator = (Story: StoryComponent) => React.ReactNode

type StoryConfig = {
  decorators?: Decorator[]
  [key: string]: unknown
}

type MetaConfig = StoryConfig & {
  title: string
  component: React.ComponentType<Record<string, unknown>>
}

const preview = {
  meta(config: MetaConfig) {
    return {
      ...config,
      story(storyConfig: StoryConfig = {}) {
        return storyConfig
      },
    }
  },
}

export default preview
