import { useStartupNotification } from './useStartupNotification.js'

export function useModelMigrationNotifications(): void {
  useStartupNotification(() => null)
}
