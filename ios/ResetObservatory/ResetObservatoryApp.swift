import SwiftUI

@main
struct ResetObservatoryApp: App {
    @StateObject private var store = ObservatoryStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .tint(ObservatoryTheme.mint)
                .preferredColorScheme(.dark)
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    await store.refresh()
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .seconds(60)) }
                        catch { return }
                        await store.refresh()
                    }
                }
        }
    }
}
