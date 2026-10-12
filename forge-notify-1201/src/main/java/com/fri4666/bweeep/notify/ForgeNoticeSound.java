package com.fri4666.bweeep.notify;

import com.fri4666.bweeep.notify.core.NoticeLevel;
import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.sounds.SoundEvent;

/**
 * The ding. The sound event is created, not registered: a client-only mod
 * must not add entries to a registry the server also knows about. The sound
 * itself is {@code sounds.json} and {@code notice.ogg} shared with the Fabric mod.
 */
final class ForgeNoticeSound {
    private static final SoundEvent DING =
            SoundEvent.createVariableRangeEvent(new ResourceLocation(BweeepNotifyMod.MOD_ID, "notice"));

    private ForgeNoticeSound() {}

    static void play(NoticeLevel level) {
        Minecraft.getInstance().getSoundManager().play(SimpleSoundInstance.forUI(DING, level.pitch(), 1.0f));
    }
}
