import BMApp
import Foundation

/// A subprocess entry point. The editor remains free while its own playback engine renders the movie.
/// The arguments and the rendering are bmapp's (runEditorMovie), shared with the desktop app.
enum EditorMovieCommand {
  static func start(_ args: [String]) -> Never {
    var arguments = bmapp.StringList()
    for argument in args { arguments.push_back(std.string(argument)) }
    if !args.contains("--recordings") {
      arguments.push_back("--recordings")
      arguments.push_back(std.string(SoundSettingsSheet.recordings))
    }
    let command = arguments
    Task.detached { exit(bmapp.runEditorMovie(command)) }
    dispatchMain()
  }
}
