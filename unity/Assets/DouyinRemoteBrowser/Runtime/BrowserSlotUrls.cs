using UdonSharp;
using UnityEngine;
using VRC.SDKBase;

public class BrowserSlotUrls : UdonSharpBehaviour
{
    public const int SLOT_COUNT = 16;
    public const int PROFILE_GUEST = 0;
    public const int PROFILE_USER_1 = 1;
    public const int PROFILE_USER_2 = 2;

    [Header("唯一需要填写的服务器地址（不要以 / 结尾）")]
    public string serverBaseUrl = "https://example.com";

    [HideInInspector] public VRCUrl createGuestUrl;
    [HideInInspector] public VRCUrl createUser1Url;
    [HideInInspector] public VRCUrl createUser2Url;
    [HideInInspector] public VRCUrl[] nextUrls;
    [HideInInspector] public VRCUrl[] prevUrls;
    [HideInInspector] public VRCUrl[] likeUrls;
    [HideInInspector] public VRCUrl[] favoriteUrls;
    [HideInInspector] public VRCUrl[] heartbeatUrls;
    [HideInInspector] public VRCUrl[] closeUrls;
    [HideInInspector] public VRCUrl[] streamUrls;

    public VRCUrl GetCreateUrl(int profileType)
    {
        if (profileType == PROFILE_USER_1) return createUser1Url;
        if (profileType == PROFILE_USER_2) return createUser2Url;
        return createGuestUrl;
    }

    public int GetCreateProfileType(VRCUrl url)
    {
        string value = url.Get();
        if (value == createUser1Url.Get()) return PROFILE_USER_1;
        if (value == createUser2Url.Get()) return PROFILE_USER_2;
        if (value == createGuestUrl.Get()) return PROFILE_GUEST;
        return -1;
    }

    public VRCUrl GetActionUrl(int slot, int action)
    {
        if (slot < 0 || slot >= SLOT_COUNT) return VRCUrl.Empty;
        if (action == 0) return prevUrls[slot];
        if (action == 1) return nextUrls[slot];
        if (action == 2) return likeUrls[slot];
        return favoriteUrls[slot];
    }

#if !COMPILER_UDONSHARP && UNITY_EDITOR
    private void OnValidate()
    {
        RebuildUrls();
    }

    [ContextMenu("重新生成 Slot 0-15 URL")]
    public void RebuildUrls()
    {
        string root = (serverBaseUrl ?? "").Trim().TrimEnd('/');
        if (!root.StartsWith("https://") && !root.StartsWith("http://")) return;

        createGuestUrl = new VRCUrl(root + "/api/session/create/guest");
        createUser1Url = new VRCUrl(root + "/api/session/create/user1");
        createUser2Url = new VRCUrl(root + "/api/session/create/user2");
        nextUrls = new VRCUrl[SLOT_COUNT];
        prevUrls = new VRCUrl[SLOT_COUNT];
        likeUrls = new VRCUrl[SLOT_COUNT];
        favoriteUrls = new VRCUrl[SLOT_COUNT];
        heartbeatUrls = new VRCUrl[SLOT_COUNT];
        closeUrls = new VRCUrl[SLOT_COUNT];
        streamUrls = new VRCUrl[SLOT_COUNT];

        for (int slot = 0; slot < SLOT_COUNT; slot++)
        {
            string api = root + "/api/session/" + slot + "/";
            nextUrls[slot] = new VRCUrl(api + "next");
            prevUrls[slot] = new VRCUrl(api + "prev");
            likeUrls[slot] = new VRCUrl(api + "like");
            favoriteUrls[slot] = new VRCUrl(api + "favorite");
            heartbeatUrls[slot] = new VRCUrl(api + "heartbeat");
            closeUrls[slot] = new VRCUrl(api + "close");
            streamUrls[slot] = new VRCUrl(root + "/stream/" + slot + "/index.m3u8");
        }
    }
#endif
}
