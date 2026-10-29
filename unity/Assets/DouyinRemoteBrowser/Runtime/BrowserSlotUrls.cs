using UdonSharp;
using UnityEngine;
using VRC.SDK3.Components;
using VRC.SDKBase;

// The original component name is retained for scene migration; it no longer creates slot URLs.
[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class BrowserSlotUrls : UdonSharpBehaviour
{
    [Header("由观看者在运行时粘贴完整观看 URL；场景中的默认值必须留空")]
    public VRCUrlInputField streamUrlInput;

    public VRCUrl GetStreamUrl()
    {
        if (streamUrlInput == null) return VRCUrl.Empty;
        return streamUrlInput.GetUrl();
    }

    public void ClearInput()
    {
        if (streamUrlInput != null) streamUrlInput.SetUrl(VRCUrl.Empty);
    }
}
