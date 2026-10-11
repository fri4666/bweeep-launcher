package com.fri4666.bweeep.notify;

import com.fri4666.bweeep.notify.core.NoticeLevel;
import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.sounds.SoundEvent;

/**
 * The ding. The sound event is created, not registered: a client-only mod
 * must not add entries to a registry the server also knows about.
 */
final class NoticeSound {
    private static final SoundEvent DING =
            SoundEvent.createVariableRangeEvent(ResourceLocation.fromNamespaceAndPath(NotifyClient.MOD_ID, "notice"));

    private NoticeSound() {}

    static void play(NoticeLevel level) {
        Minecraft.getInstance().getSoundManager().play(SimpleSoundInstance.forUI(DING, level.pitch(), 1.0f));
    }
}
