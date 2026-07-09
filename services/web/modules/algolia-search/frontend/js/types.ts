export type AlgoliaConfig = {
  appId: string
  apiKey: string
  indexes: {
    wiki?: string
    [key: string]: string | undefined
  }
}
