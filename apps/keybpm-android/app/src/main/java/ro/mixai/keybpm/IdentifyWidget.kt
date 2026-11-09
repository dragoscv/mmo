package ro.mixai.keybpm

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * One-tap "Identify song" home-screen widget (WP18-06). It opens the app with [ACTION_IDENTIFY]; the activity is
 * in the foreground then, which is what Android requires to start microphone capture + the FGS.
 */
class IdentifyWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val open = Intent(context, MainActivity::class.java).setAction(ACTION_IDENTIFY).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        for (id in ids) {
            val views = RemoteViews(context.packageName, R.layout.widget_identify).apply { setOnClickPendingIntent(R.id.widget_root, pi) }
            manager.updateAppWidget(id, views)
        }
    }

    companion object {
        const val ACTION_IDENTIFY = "ro.mixai.keybpm.IDENTIFY"
    }
}
