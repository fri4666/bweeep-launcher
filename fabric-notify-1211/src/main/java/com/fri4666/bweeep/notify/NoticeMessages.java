package com.fri4666.bweeep.notify;

import com.fri4666.bweeep.notify.core.Notice;
import com.fri4666.bweeep.notify.core.NoticeParser;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.contents.TranslatableContents;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/** Turns a system chat message into a notice. Only server system messages come through here, never player chat. */
final class NoticeMessages {
    private NoticeMessages() {}

    static Optional<Notice> fromComponent(Component message) {
        if (!(message.getContents() instanceof TranslatableContents contents)) return Optional.empty();
        if (!NoticeParser.KEY.equals(contents.getKey())) return Optional.empty();
        List<String> args = new ArrayList<>();
        for (Object arg : contents.getArgs()) {
            args.add(arg instanceof Component component ? component.getString() : String.valueOf(arg));
        }
        return NoticeParser.parse(contents.getKey(), args);
    }
}
