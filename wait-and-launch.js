setTimeout(() => {
  require("child_process").spawn(
    require("electron"),
    ["."],
    { stdio: "inherit", cwd: __dirname }
  );
}, 3000);
