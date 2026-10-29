using UdonSharp;
using UnityEngine;
using UnityEngine.UI;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class DouyinBrowserUI : UdonSharpBehaviour
{
    public DouyinBrowserManager manager;

    [Header("本地播放状态；不要在状态文字中显示观看 URL")]
    public Text playbackText;
    public Text statusText;

    [Header("只读观看按钮")]
    public Button playButton;
    public Button stopButton;

    private void Start()
    {
        Refresh();
    }

    public void Refresh()
    {
        if (manager == null) return;
        if (playbackText != null)
            playbackText.text = manager.localPlaying ? "本地视频：正在播放"
                : manager.localPlaybackRequested ? "本地视频：正在加载" : "本地视频：已停止";
        if (statusText != null) statusText.text = manager.currentStatus;
        if (playButton != null) playButton.interactable = !manager.localPlaybackRequested;
        if (stopButton != null) stopButton.interactable = true;
    }

    public void PlayEnteredStream()
    {
        if (manager != null) manager.PlayEnteredStream();
    }

    public void StopPlayback()
    {
        if (manager != null) manager.StopPlayback();
    }
}
