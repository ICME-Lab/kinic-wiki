package xyz.kinic.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

internal object KinicDesign {
    val HotPink = Color(0xFFFF2686)
    val PalePink = Color(0xFFFFCEE5)
    val PanelGray = Color(0xFFF8F8F8)
    val HairlineGray = Color(0xFFE6E6E6)
    val BodyGray = Color(0xFF636161)
    val ElectricIndigo = Color(0xFF3324D5)
    val WarmYellow = Color(0xFFFDB52A)

    val PanelShape = RoundedCornerShape(20.dp)
    val ControlShape = RoundedCornerShape(16.dp)
    val ScreenPadding = 16.dp
    val PanelPadding = 20.dp
}

private val kinicTypography = Typography().let { base ->
    Typography(
        displayLarge = base.displayLarge.copy(letterSpacing = 0.sp),
        displayMedium = base.displayMedium.copy(letterSpacing = 0.sp),
        displaySmall = base.displaySmall.copy(letterSpacing = 0.sp),
        headlineLarge = base.headlineLarge.copy(letterSpacing = 0.sp),
        headlineMedium = base.headlineMedium.copy(letterSpacing = 0.sp),
        headlineSmall = base.headlineSmall.copy(letterSpacing = 0.sp),
        titleLarge = base.titleLarge.copy(letterSpacing = 0.sp),
        titleMedium = base.titleMedium.copy(letterSpacing = 0.sp),
        titleSmall = base.titleSmall.copy(letterSpacing = 0.sp),
        bodyLarge = base.bodyLarge.copy(letterSpacing = 0.sp),
        bodyMedium = base.bodyMedium.copy(letterSpacing = 0.sp),
        bodySmall = base.bodySmall.copy(letterSpacing = 0.sp),
        labelLarge = base.labelLarge.copy(letterSpacing = 0.sp),
        labelMedium = base.labelMedium.copy(letterSpacing = 0.sp),
        labelSmall = base.labelSmall.copy(letterSpacing = 0.sp),
    )
}

@Composable
internal fun KinicTheme(useDark: Boolean, content: @Composable () -> Unit) {
    val colors = if (useDark) {
        darkColorScheme(
            primary = KinicDesign.HotPink,
            onPrimary = Color.White,
            primaryContainer = Color(0xFF5A1737),
            onPrimaryContainer = Color(0xFFFFD9E8),
            background = Color(0xFF101010),
            surface = Color(0xFF101010),
            surfaceVariant = Color(0xFF1C1C1E),
            outline = Color(0xFF3A3A3C),
        )
    } else {
        lightColorScheme(
            primary = KinicDesign.HotPink,
            onPrimary = Color.White,
            primaryContainer = KinicDesign.PalePink,
            onPrimaryContainer = Color.Black,
            secondary = KinicDesign.ElectricIndigo,
            tertiary = KinicDesign.WarmYellow,
            background = Color.White,
            surface = Color.White,
            surfaceVariant = KinicDesign.PanelGray,
            onSurfaceVariant = KinicDesign.BodyGray,
            outline = KinicDesign.HairlineGray,
        )
    }
    val view = LocalView.current
    SideEffect {
        val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
        val insetsController = WindowCompat.getInsetsController(
            window,
            view,
        )
        insetsController.isAppearanceLightStatusBars = !useDark
        insetsController.isAppearanceLightNavigationBars = !useDark
    }
    MaterialTheme(
        colorScheme = colors,
        typography = kinicTypography,
        content = content,
    )
}

@Composable
internal fun KinicHeaderTitle() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        androidx.compose.foundation.Image(
            painter = painterResource(R.drawable.kinic_mark),
            contentDescription = null,
            modifier = Modifier.size(24.dp),
        )
        Text(
            text = "KinicWiki",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
internal fun KinicPanel(
    title: String,
    icon: ImageVector,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = KinicDesign.PanelShape,
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Column(
            modifier = Modifier.padding(KinicDesign.PanelPadding),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(12.dp))
                Text(
                    text = title,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.MiddleEllipsis,
                )
                trailing?.invoke()
            }
            content()
        }
    }
}

@Composable
internal fun KinicBadge(text: String) {
    Surface(
        shape = RoundedCornerShape(50),
        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp),
            color = MaterialTheme.colorScheme.primary,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
        )
    }
}
